#include "rules/event_runtime.hpp"
#include "storage/sqlite_store.hpp"

#undef NDEBUG
#include <cassert>
#include <string>

int main() {
  wardy::storage::SqliteStore database(":memory:");
  database.initialize();
  int changes = 0;
  wardy::rules::EventRuntime runtime(database, [&changes](const auto&) { ++changes; });

  wardy::rules::EventObservation hazard{
      "hazard_detected", true, "2026-08-10T10:00:00Z", "subject-1", "돌봄 대상",
      "거실", "object-1", "가위", std::nullopt, "위험물이 탐지됨", "[]"};
  const auto created = runtime.apply(hazard);
  assert(created.created);
  assert(created.event.care_status == "caution");
  assert(created.event.media_type == "image");
  assert(runtime.current_care_status() == "caution");

  hazard.observed_at = "2026-08-10T10:00:01Z";
  const auto merged = runtime.apply(hazard);
  assert(!merged.created);
  assert(merged.event.event_id == created.event.event_id);
  assert(database.list_events().size() == 1);

  wardy::rules::EventObservation fall{
      "fall_suspected", true, "2026-08-10T10:00:02Z", "subject-1", "돌봄 대상",
      "거실", std::nullopt, std::nullopt, std::nullopt, "낙상 의심", "[]"};
  const auto emergency = runtime.apply(fall);
  assert(emergency.event.care_status == "emergency");
  assert(emergency.event.media_type == "video");
  assert(runtime.current_care_status() == "emergency");

  fall.active = false;
  fall.observed_at = "2026-08-10T10:00:03Z";
  const auto released = runtime.apply(fall);
  assert(released.released);
  assert(released.event.event_status == "released");
  assert(runtime.current_care_status() == "caution");

  assert(runtime.update_status(created.event.event_id, "confirmed",
                               "2026-08-10T10:00:04Z"));
  assert(runtime.update_status(created.event.event_id, "false_detection",
                               "2026-08-10T10:00:05Z"));
  bool rejected_terminal_change = false;
  try {
    runtime.update_status(created.event.event_id, "confirmed",
                          "2026-08-10T10:00:06Z");
  } catch (const std::invalid_argument&) {
    rejected_terminal_change = true;
  }
  assert(rejected_terminal_change);
  assert(runtime.current_care_status() == "normal");
  assert(changes == 6);
  return 0;
}
