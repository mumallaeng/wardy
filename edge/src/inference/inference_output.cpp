#include "inference/inference_output.hpp"

#include "api/json_serialization.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace wardy::inference {
namespace {

bool valid_source(const std::string& value) {
  return value == "temporary" || value == "model";
}

void validate_detection(const DetectionOutput& detection) {
  if (detection.id.empty() || detection.class_name.empty()) {
    throw std::invalid_argument("inference detection id and class must not be empty");
  }
  for (double value : detection.box) {
    if (!std::isfinite(value)) throw std::invalid_argument("inference box must be finite");
  }
  if (detection.box[0] < 0.0 || detection.box[1] < 0.0 ||
      detection.box[2] <= 0.0 || detection.box[3] <= 0.0 ||
      detection.box[0] + detection.box[2] > 1.0 ||
      detection.box[1] + detection.box[3] > 1.0) {
    throw std::invalid_argument("inference box must be normalized x,y,width,height");
  }
  if (!std::isfinite(detection.confidence) || detection.confidence < 0.0 ||
      detection.confidence > 1.0) {
    throw std::invalid_argument("inference confidence must be between 0 and 1");
  }
}

rules::EventObservation observation(
    const InferenceFrame& frame, const DetectionOutput& detection,
    const std::string& event_type, const std::string& reason,
    bool object_detection) {
  rules::EventObservation result;
  result.event_type = event_type;
  result.active = true;
  result.observed_at = frame.observed_at;
  result.subject_location = "camera";
  result.reason = reason;
  if (object_detection) {
    // M-05 does not track objects across frames yet. Use the class as the
    // stable event identity while preserving the frame-local overlay ID.
    result.object_id = detection.class_name;
    result.object_class = detection.class_name;
  } else {
    result.subject_id = detection.subject_id.value_or(detection.id);
    if (!detection.name.empty()) result.subject_name = detection.name;
  }
  return result;
}

}  // namespace

std::optional<std::array<double, 4>> normalized_response_box(
    const std::array<float, 4>& box, int frame_width, int frame_height) {
  if (frame_width <= 0 || frame_height <= 0) return std::nullopt;
  const double x0 = std::clamp(static_cast<double>(box[0]) / frame_width, 0.0, 1.0);
  const double y0 = std::clamp(static_cast<double>(box[1]) / frame_height, 0.0, 1.0);
  const double x1 = std::clamp(static_cast<double>(box[2]) / frame_width, 0.0, 1.0);
  const double y1 = std::clamp(static_cast<double>(box[3]) / frame_height, 0.0, 1.0);
  if (x1 <= x0 || y1 <= y0) return std::nullopt;
  return std::array<double, 4>{x0, y0, x1 - x0, y1 - y0};
}

InferenceOutputRuntime::InferenceOutputRuntime(
    rules::EventRuntime& events, ChangeCallback on_change)
    : events_(events), on_change_(std::move(on_change)) {}

void InferenceOutputRuntime::validate(const InferenceFrame& frame) {
  if (frame.frame_id.empty() || frame.observed_at.empty() || !valid_source(frame.source)) {
    throw std::invalid_argument("inference frame id, timestamp, and source are required");
  }
  if (!frame.operational && frame.fault_reason.empty()) {
    throw std::invalid_argument("non-operational inference requires a fault reason");
  }
  std::set<std::string> ids;
  for (const auto& person : frame.people) {
    validate_detection(person.detection);
    if (!ids.insert(person.detection.id).second) {
      throw std::invalid_argument("inference detection ids must be unique");
    }
  }
  for (const auto& hazard : frame.hazards) {
    validate_detection(hazard.detection);
    if (!ids.insert(hazard.detection.id).second) {
      throw std::invalid_argument("inference detection ids must be unique");
    }
  }
}

std::string InferenceOutputRuntime::event_key(
    const rules::EventObservation& observation,
    const std::string& stable_subject_id) {
  return observation.event_type + "|" +
      (stable_subject_id.empty()
           ? observation.subject_id.value_or("")
           : stable_subject_id) +
      "|" + observation.object_id.value_or("");
}

std::string InferenceOutputRuntime::source_results(
    const InferenceFrame& frame, double confidence) {
  return "[{\"source\":" + api::json_string(frame.source) +
      ",\"frame_id\":" + api::json_string(frame.frame_id) +
      ",\"confidence\":" + api::json_number(confidence) + "}]";
}

void InferenceOutputRuntime::apply(const InferenceFrame& frame) {
  std::lock_guard operation_lock(operation_mutex_);
  validate(frame);
  InferenceSnapshot next;
  next.source = frame.source;
  next.observed_at = frame.observed_at;
  next.operational = frame.operational;
  next.fault_reason = frame.fault_reason;
  std::map<std::string, ActiveObservation> next_events;

  if (!frame.operational) {
    rules::EventObservation fault;
    fault.event_type = "detection_fault";
    fault.active = true;
    fault.observed_at = frame.observed_at;
    fault.subject_location = "camera";
    fault.reason = frame.fault_reason;
    fault.source_results_json = source_results(frame, 0.0);
    next_events.emplace(event_key(fault), ActiveObservation{fault});
  } else {
    for (const auto& person : frame.people) {
      next.detections.push_back(person.detection);
      if (person.fall_suspected) {
        auto event = observation(frame, person.detection, "fall_suspected",
            "낙상 의심 자세가 감지되었습니다.", false);
        event.source_results_json = source_results(frame, person.detection.confidence);
        next_events.emplace(event_key(event, person.detection.id),
                            ActiveObservation{event});
      }
      if (person.inactive) {
        auto event = observation(frame, person.detection, "inactivity",
            "움직임이 기준 시간 이상 감지되지 않았습니다.", false);
        event.source_results_json = source_results(frame, person.detection.confidence);
        next_events.emplace(event_key(event, person.detection.id),
                            ActiveObservation{event});
      }
    }
    for (const auto& hazard : frame.hazards) {
      next.detections.push_back(hazard.detection);
      if (!hazard.included) continue;
      auto detected = observation(frame, hazard.detection, "hazard_detected",
          "관리 대상 위험물이 감지되었습니다.", true);
      detected.source_results_json = source_results(frame, hazard.detection.confidence);
      next_events.emplace(event_key(detected), ActiveObservation{detected});
      if (hazard.near_person) {
        auto proximity = observation(frame, hazard.detection, "hazard_proximity",
            "위험물이 사람 가까이에서 감지되었습니다.", true);
        proximity.source_results_json = source_results(frame, hazard.detection.confidence);
        next_events.emplace(event_key(proximity), ActiveObservation{proximity});
      }
    }
  }

  std::map<std::string, ActiveObservation> previous_events;
  {
    std::lock_guard lock(mutex_);
    snapshot_ = next;
    previous_events = active_events_;
    for (auto& [key, active] : next_events) {
      const auto previous = previous_events.find(key);
      if (previous == previous_events.end()) continue;
      // EventRuntime correlates persisted events with their initial subject ID.
      // Keep that metadata stable until release while the outer key follows the
      // M-02 track ID and tolerates frame-to-frame identity flicker.
      active.observation.subject_id = previous->second.observation.subject_id;
      active.observation.subject_name = previous->second.observation.subject_name;
    }
    active_events_ = next_events;
  }

  for (const auto& [key, active] : next_events) {
    if (!previous_events.count(key)) events_.apply(active.observation);
  }
  for (const auto& [key, previous] : previous_events) {
    if (next_events.count(key)) continue;
    auto released = previous.observation;
    released.active = false;
    released.observed_at = frame.observed_at;
    events_.apply(released);
  }
  if (on_change_) on_change_();
}

InferenceSnapshot InferenceOutputRuntime::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}

TemporaryInferenceProducer::TemporaryInferenceProducer(std::string scenario)
    : scenario_(std::move(scenario)) {
  const std::set<std::string> supported{
      "normal", "fall", "inactivity", "hazard", "proximity", "fault"};
  if (!supported.count(scenario_)) {
    throw std::invalid_argument("unsupported temporary inference scenario: " + scenario_);
  }
}

InferenceFrame TemporaryInferenceProducer::infer(
    const std::string& frame_id, const std::string& observed_at) const {
  InferenceFrame frame;
  frame.frame_id = frame_id;
  frame.observed_at = observed_at;
  frame.source = "temporary";
  if (scenario_ == "fault") {
    frame.operational = false;
    frame.fault_reason = "임시 출력에서 감지 기능 이상 시나리오를 실행 중입니다.";
    return frame;
  }

  PersonOutput person;
  person.detection = {
      "temporary-person-1", {0.34, 0.14, 0.26, 0.72}, "사람",
      "돌봄 대상", "", "서 있음", 0.94, "#62b88f", std::nullopt};
  if (scenario_ == "fall") {
    person.fall_suspected = true;
    person.detection.box = {0.25, 0.62, 0.52, 0.25};
    person.detection.posture = "낙상 의심";
    person.detection.color = "#d85d52";
  } else if (scenario_ == "inactivity") {
    person.inactive = true;
    person.detection.posture = "장시간 정지";
    person.detection.color = "#d28b2d";
  }
  frame.people.push_back(person);

  if (scenario_ == "hazard" || scenario_ == "proximity") {
    HazardOutput hazard;
    hazard.detection = {
        "temporary-hazard-1",
        scenario_ == "proximity" ? std::array<double, 4>{0.55, 0.58, 0.13, 0.12}
                                  : std::array<double, 4>{0.76, 0.68, 0.13, 0.12},
        "가위", "관리 위험물", "", "", 0.91,
        scenario_ == "proximity" ? "#d85d52" : "#d28b2d", std::nullopt};
    hazard.near_person = scenario_ == "proximity";
    frame.hazards.push_back(hazard);
  }
  return frame;
}

std::string inference_json(const InferenceSnapshot& snapshot) {
  std::string body = "{\"source\":" + api::json_string(snapshot.source) +
      ",\"observed_at\":" + api::json_string(snapshot.observed_at) +
      ",\"operational\":" + (snapshot.operational ? "true" : "false") +
      ",\"fault_reason\":" + api::json_string(snapshot.fault_reason) +
      ",\"detections\":[";
  for (std::size_t index = 0; index < snapshot.detections.size(); ++index) {
    if (index > 0) body += ',';
    const auto& detection = snapshot.detections[index];
    body += "{\"id\":" + api::json_string(detection.id) +
        ",\"box\":[" + api::json_number(detection.box[0]) + "," +
        api::json_number(detection.box[1]) + "," + api::json_number(detection.box[2]) +
        "," + api::json_number(detection.box[3]) + "]" +
        ",\"className\":" + api::json_string(detection.class_name) +
        ",\"role\":" + api::json_string(detection.role) +
        ",\"name\":" + api::json_string(detection.name) +
        ",\"posture\":" + api::json_string(detection.posture) +
        ",\"confidence\":" + api::json_number(detection.confidence) +
        ",\"color\":" + api::json_string(detection.color) +
        ",\"subjectId\":" +
        (detection.subject_id ? api::json_string(*detection.subject_id) : "null") + "}";
  }
  return body + "]}";
}

std::string inference_message_json(const InferenceSnapshot& snapshot) {
  return "{\"type\":\"inference\",\"inference\":" + inference_json(snapshot) + "}";
}

}  // namespace wardy::inference
