#include "inference/inference_output.hpp"
#include "rules/event_runtime.hpp"
#include "storage/sqlite_store.hpp"

#undef NDEBUG
#include <cassert>
#include <stdexcept>
#include <string>

int main() {
  const auto clipped = wardy::inference::normalized_response_box(
      {-20.0F, 10.0F, 120.0F, 40.0F}, 100, 100);
  assert(clipped.has_value());
  assert((*clipped)[0] == 0.0);
  assert((*clipped)[2] == 1.0);
  assert(!wardy::inference::normalized_response_box(
      {120.0F, 10.0F, 140.0F, 40.0F}, 100, 100).has_value());

  wardy::storage::SqliteStore database(":memory:");
  database.initialize();
  wardy::rules::EventRuntime events(database);
  int changes = 0;
  wardy::inference::InferenceOutputRuntime runtime(events, [&changes] { ++changes; });

  wardy::inference::TemporaryInferenceProducer normal("normal");
  runtime.apply(normal.infer("frame-1", "2026-08-12T00:00:00Z"));
  auto snapshot = runtime.snapshot();
  assert(snapshot.source == "temporary");
  assert(snapshot.operational);
  assert(snapshot.detections.size() == 1);
  assert(database.list_events().empty());

  wardy::inference::TemporaryInferenceProducer fall("fall");
  auto recognized_fall = fall.infer("frame-2", "2026-08-12T00:00:01Z");
  recognized_fall.people.front().detection.subject_id = "subject-1";
  recognized_fall.people.front().detection.name = "등록 인물";
  runtime.apply(recognized_fall);
  assert(database.list_events().size() == 1);
  assert(database.list_events().front().event_type == "fall_suspected");
  assert(database.list_events().front().event_status == "new");
  assert(database.list_events().front().subject_id == "subject-1");

  // Recognition can disappear frame-to-frame while the M-02 track remains.
  // The active event must keep its track-derived key instead of churning.
  runtime.apply(fall.infer("frame-3", "2026-08-12T00:00:02Z"));
  assert(database.list_events().size() == 1);
  assert(database.list_events().front().event_status == "new");

  runtime.apply(normal.infer("frame-4", "2026-08-12T00:00:03Z"));
  assert(database.list_events().front().event_status == "released");

  wardy::inference::TemporaryInferenceProducer proximity("proximity");
  runtime.apply(proximity.infer("frame-5", "2026-08-12T00:00:04Z"));
  const auto hazard_events = database.list_events();
  assert(hazard_events.size() == 3);
  assert(runtime.snapshot().detections.size() == 2);

  wardy::inference::TemporaryInferenceProducer fault("fault");
  runtime.apply(fault.infer("frame-6", "2026-08-12T00:00:05Z"));
  snapshot = runtime.snapshot();
  assert(!snapshot.operational);
  assert(snapshot.detections.empty());
  assert(database.list_events().front().event_type == "detection_fault");
  assert(changes == 6);

  runtime.apply(normal.infer("frame-6b", "2026-08-12T00:00:05.5Z"));
  snapshot = runtime.snapshot();
  assert(snapshot.operational);
  bool fault_released = false;
  for (const auto& event : database.list_events()) {
    if (event.event_type == "detection_fault") {
      fault_released = event.event_status == "released";
    }
  }
  assert(fault_released);
  assert(changes == 7);

  const std::string json = wardy::inference::inference_json(snapshot);
  assert(json.find("\"source\":\"temporary\"") != std::string::npos);
  assert(wardy::inference::inference_message_json(snapshot).find(
      "\"type\":\"inference\"") != std::string::npos);

  bool rejected = false;
  try {
    wardy::inference::TemporaryInferenceProducer invalid("unknown");
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  assert(rejected);

  auto invalid_frame = normal.infer("frame-7", "2026-08-12T00:00:06Z");
  invalid_frame.people.front().detection.box = {0.9, 0.1, 0.2, 0.2};
  rejected = false;
  try {
    runtime.apply(invalid_frame);
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  assert(rejected);
  assert(changes == 7);
  return 0;
}
