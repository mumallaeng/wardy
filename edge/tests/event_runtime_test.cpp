#include "rules/event_runtime.hpp"
#include "storage/sqlite_store.hpp"

#undef NDEBUG
#include <cassert>
#include <string>
#include <vector>

int main() {
  wardy::storage::SqliteStore database(":memory:");
  database.initialize();
  std::vector<std::string> changed_events;
  wardy::rules::EventRuntime runtime(database, [&changed_events](const auto& event) {
    changed_events.push_back(event.event_id);
  });
  assert(!runtime.has_active_event_type("camera_fault"));

  wardy::rules::EventObservation hazard{
      "hazard_detected", true, "2026-08-10T10:00:00Z", "subject-1", "돌봄 대상",
      "거실", "object-1", "가위", std::nullopt, "위험물이 탐지됨", "[]"};
  const auto created = runtime.apply(hazard);
  assert(changed_events.back() == created.event.event_id);
  assert(created.created);
  assert(created.event.care_status == "caution");
  assert(created.event.media_type == "image");
  assert(runtime.current_care_status() == "caution");

  assert(database.update_event_media(created.event.event_id, "image",
                                     "EVT-HAZARD.jpg",
                                     "2026-08-10T10:00:00Z",
                                     "2026-08-10T10:00:00Z"));

  hazard.observed_at = "2026-08-10T10:00:01Z";
  const auto merged = runtime.apply(hazard);
  assert(changed_events.back() == created.event.event_id);
  assert(!merged.created);
  assert(merged.event.event_id == created.event.event_id);
  assert(merged.event.media_path == "EVT-HAZARD.jpg");
  assert(database.get_event(created.event.event_id)->media_path == "EVT-HAZARD.jpg");
  assert(database.list_events().size() == 1);

  wardy::rules::EventObservation fall{
      "fall_suspected", true, "2026-08-10T10:00:02Z", "subject-1", "돌봄 대상",
      "거실", std::nullopt, std::nullopt, std::nullopt, "낙상 의심", "[]"};
  const auto emergency = runtime.apply(fall);
  assert(changed_events.back() == emergency.event.event_id);
  assert(emergency.event.care_status == "emergency");
  assert(emergency.event.media_type == "video");
  assert(runtime.current_care_status() == "emergency");

  fall.active = false;
  fall.observed_at = "2026-08-10T10:00:03Z";
  const auto latched = runtime.apply(fall);
  assert(!latched.released);
  assert(latched.event.event_status == "new");
  assert(runtime.current_care_status() == "emergency");
  assert(runtime.update_status(emergency.event.event_id, "released",
                               "2026-08-10T10:00:04Z"));
  assert(runtime.current_care_status() == "caution");

  assert(runtime.update_status(created.event.event_id, "confirmed",
                               "2026-08-10T10:00:04Z"));
  assert(changed_events.back() == created.event.event_id);
  assert(runtime.update_status(created.event.event_id, "false_detection",
                               "2026-08-10T10:00:05Z"));
  assert(changed_events.back() == created.event.event_id);
  bool rejected_terminal_change = false;
  try {
    runtime.update_status(created.event.event_id, "confirmed",
                          "2026-08-10T10:00:06Z");
  } catch (const std::invalid_argument&) {
    rejected_terminal_change = true;
  }
  assert(rejected_terminal_change);
  assert(runtime.current_care_status() == "normal");
  wardy::rules::EventObservation camera_fault{
      "camera_fault", true, "2026-08-10T10:00:06Z", std::nullopt, std::nullopt,
      "unknown", std::nullopt, std::nullopt, std::nullopt,
      "카메라 입력이 중단됨", "[]"};
  const auto fault = runtime.apply(camera_fault);
  assert(changed_events.back() == fault.event.event_id);
  assert(runtime.has_active_event_type("camera_fault"));
  assert(runtime.current_care_status() == "normal");
  assert(runtime.current_reason() == "활성화된 안전 이벤트가 없습니다.");
  camera_fault.active = false;
  camera_fault.observed_at = "2026-08-10T10:00:07Z";
  const auto cleared_fault = runtime.apply(camera_fault);
  assert(changed_events.back() == cleared_fault.event.event_id);
  assert(!runtime.has_active_event_type("camera_fault"));
  assert(runtime.current_care_status() == "normal");

  // A service restart restores active fall events from SQLite. Releasing the
  // restored incident must use its persisted subject key rather than inventing
  // a new track-* identity when the in-memory identity map is empty.
  wardy::storage::SqliteStore persisted_database(":memory:");
  persisted_database.initialize();
  wardy::rules::EventRuntime before_restart(persisted_database);
  wardy::rules::EventObservation persisted_fall{
      "fall_suspected", true, "2026-08-10T10:01:00Z", "subject-7", "돌봄 대상",
      "거실", std::nullopt, std::nullopt, std::nullopt, "낙상 의심",
      R"([{"source":"m02_m04_pose_sequence","track_id":7}])"};
  const auto persisted_created = before_restart.apply(persisted_fall);
  assert(persisted_created.created);
  wardy::rules::EventRuntime after_restart(persisted_database);
  persisted_fall.active = false;
  persisted_fall.observed_at = "2026-08-10T10:01:01Z";
  const auto persisted_latched = after_restart.apply(persisted_fall);
  assert(!persisted_latched.released);
  assert(persisted_latched.event.subject_id ==
         std::optional<std::string>("subject-7"));
  assert(after_restart.update_status(persisted_created.event.event_id, "confirmed",
                                     "2026-08-10T10:01:02Z"));
  assert(!after_restart.has_active_event_type("fall_suspected"));
  const auto confirmed_inactive = after_restart.apply(persisted_fall);
  assert(confirmed_inactive.event.event_id.empty());
  persisted_fall.active = true;
  persisted_fall.observed_at = "2026-08-10T10:01:03Z";
  const auto subsequent_fall = after_restart.apply(persisted_fall);
  assert(subsequent_fall.created);
  assert(subsequent_fall.event.event_id != persisted_created.event.event_id);

  wardy::storage::SqliteStore restore_database(":memory:");
  restore_database.initialize();
  wardy::storage::EventRecord old_active = created.event;
  old_active.event_id = "EVT-OLD-ACTIVE";
  old_active.event_status = "new";
  old_active.occurred_at = "2020-01-01T00:00:00Z";
  old_active.first_seen_at = old_active.occurred_at;
  old_active.last_seen_at = old_active.occurred_at;
  restore_database.upsert_event(old_active);
  for (int index = 0; index < 1001; ++index) {
    wardy::storage::EventRecord terminal = old_active;
    terminal.event_id = "EVT-TERMINAL-" + std::to_string(index);
    terminal.event_status = "released";
    terminal.occurred_at = "2026-08-10T12:" + std::to_string(index / 60) + ":" +
                           std::to_string(index % 60) + "Z";
    terminal.first_seen_at = terminal.occurred_at;
    terminal.last_seen_at = terminal.occurred_at;
    restore_database.upsert_event(terminal);
  }
  wardy::rules::EventRuntime restored_runtime(restore_database);
  assert(restored_runtime.has_active_event_type("hazard_detected"));
  assert(restored_runtime.current_care_status() == "caution");
  return 0;
}
