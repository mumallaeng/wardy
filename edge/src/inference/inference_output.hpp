#pragma once

#include "rules/event_runtime.hpp"

#include <array>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wardy::inference {

struct DetectionOutput {
  std::string id;
  std::array<double, 4> box{};  // normalized x, y, width, height
  std::string class_name;
  std::string role;
  std::string name;
  std::string posture;
  double confidence = 0.0;
  std::string color = "#62b88f";
};

struct PersonOutput {
  DetectionOutput detection;
  bool fall_suspected = false;
  bool inactive = false;
};

struct HazardOutput {
  DetectionOutput detection;
  bool included = true;
  bool near_person = false;
};

struct InferenceFrame {
  std::string frame_id;
  std::string observed_at;
  std::string source = "model";
  bool operational = true;
  std::string fault_reason;
  std::vector<PersonOutput> people;
  std::vector<HazardOutput> hazards;
};

struct InferenceSnapshot {
  std::string source = "none";
  std::string observed_at;
  bool operational = false;
  std::string fault_reason;
  std::vector<DetectionOutput> detections;
};

std::optional<std::array<double, 4>> normalized_response_box(
    const std::array<float, 4>& box, int frame_width, int frame_height);

class InferenceOutputRuntime {
 public:
  using ChangeCallback = std::function<void()>;

  explicit InferenceOutputRuntime(rules::EventRuntime& events,
                                  ChangeCallback on_change = {});

  void apply(const InferenceFrame& frame);
  [[nodiscard]] InferenceSnapshot snapshot() const;

 private:
  struct ActiveObservation {
    rules::EventObservation observation;
  };

  static void validate(const InferenceFrame& frame);
  static std::string event_key(const rules::EventObservation& observation);
  static std::string source_results(const InferenceFrame& frame,
                                    double confidence);

  rules::EventRuntime& events_;
  ChangeCallback on_change_;
  std::mutex operation_mutex_;
  mutable std::mutex mutex_;
  InferenceSnapshot snapshot_;
  std::map<std::string, ActiveObservation> active_events_;
};

class TemporaryInferenceProducer {
 public:
  explicit TemporaryInferenceProducer(std::string scenario = "normal");
  [[nodiscard]] InferenceFrame infer(const std::string& frame_id,
                                     const std::string& observed_at) const;

 private:
  std::string scenario_;
};

std::string inference_json(const InferenceSnapshot& snapshot);
std::string inference_message_json(const InferenceSnapshot& snapshot);

}  // namespace wardy::inference
