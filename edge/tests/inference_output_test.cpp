#include "inference/inference_output.hpp"
#include "rules/event_runtime.hpp"
#include "storage/sqlite_store.hpp"

#undef NDEBUG
#include <cassert>
#include <stdexcept>
#include <string>

int main() {
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
  runtime.apply(fall.infer("frame-2", "2026-08-12T00:00:01Z"));
  assert(database.list_events().size() == 1);
  assert(database.list_events().front().event_type == "fall_suspected");
  assert(database.list_events().front().event_status == "new");

  runtime.apply(fall.infer("frame-3", "2026-08-12T00:00:02Z"));
  assert(database.list_events().size() == 1);

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
  assert(changes == 6);
  return 0;
}
