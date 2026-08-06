#include "storage/sqlite_store.hpp"

#include <cassert>

int main() {
  wardy::storage::SqliteStore store(":memory:");
  store.initialize();
  assert(store.journal_mode() == "memory");
  assert(store.schema_version() == "2");

  wardy::storage::EventRecord event;
  event.event_id = "EVT-TEST-001";
  event.event_type = "hazard_proximity";
  event.occurred_at = "2026-08-06T12:00:00+09:00";
  event.first_seen_at = event.occurred_at;
  event.last_seen_at = event.occurred_at;
  event.subject_id = "subject-1";
  event.subject_name = "돌봄 대상";
  event.subject_location = "주방";
  event.object_class = "knife";
  event.care_status = "warning";
  event.event_status = "new";
  event.reason = "위험물과 돌봄 대상자가 가까움";
  event.source_results_json = R"([{"source":"rule","confidence":0.9}])";
  event.media_type = "video";
  event.media_path = "media/EVT-TEST-001.mp4";
  store.upsert_event(event);

  auto events = store.list_events();
  assert(events.size() == 1);
  assert(events[0].event_id == event.event_id);
  assert(events[0].care_status == "warning");
  assert(events[0].media_path == event.media_path);

  assert(store.update_event_status(event.event_id, "confirmed",
                                   "2026-08-06T12:01:00+09:00"));
  events = store.list_events();
  assert(events[0].event_status == "confirmed");
  assert(events[0].confirmed_at == "2026-08-06T12:01:00+09:00");
  assert(!store.update_event_status("missing", "confirmed",
                                    "2026-08-06T12:01:00+09:00"));

  wardy::storage::SystemStateRecord state{
      "warning", "connected", "running", "ready",
      "위험물 근접 event 활성", "2026-08-06T12:01:00+09:00",
  };
  store.save_system_state(state);
  const auto restored = store.load_system_state();
  assert(restored.has_value());
  assert(restored->care_state == "warning");
  assert(restored->camera_state == "connected");

  const wardy::storage::ManagedItemRecord item{
      "item-knife", "주방 칼", "included",
      "2026-08-06T12:02:00+09:00", "2026-08-06T12:02:00+09:00",
  };
  store.upsert_managed_item(item);
  store.add_training_sample({
      "sample-001", item.item_id, "items/item-knife/images/sample-001.jpg",
      "2026-08-06T12:03:00+09:00", 640, 480,
  });
  assert(store.count_training_samples(item.item_id) == 1);
  return 0;
}
