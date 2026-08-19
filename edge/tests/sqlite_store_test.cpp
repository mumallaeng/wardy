#include "storage/sqlite_store.hpp"

#undef NDEBUG
#include <cassert>
#include <filesystem>
#include <sqlite3.h>
#include <string>

namespace {

void create_version_database(const std::filesystem::path &path, int version) {
  sqlite3 *database = nullptr;
  assert(sqlite3_open(path.string().c_str(), &database) == SQLITE_OK);
  std::string sql =
      "CREATE TABLE schema_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
      "INSERT INTO schema_metadata(key, value) VALUES('schema_version', '" +
      std::to_string(version) +
      "');"
      "CREATE TABLE events("
      "event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,occurred_at TEXT NOT "
      "NULL,"
      "first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,subject_id TEXT,"
      "subject_name TEXT,subject_location TEXT NOT NULL,object_id "
      "TEXT,object_class TEXT,"
      "zone_id TEXT,care_status TEXT,event_status TEXT NOT NULL,confirmed_at "
      "TEXT,"
      "released_at TEXT,false_detection_at TEXT,reason TEXT NOT NULL,"
      "source_results_json TEXT NOT NULL DEFAULT '[]',media_type TEXT NOT NULL,"
      "media_path TEXT,media_started_at TEXT,media_ended_at TEXT);"
      "INSERT INTO "
      "events(event_id,event_type,occurred_at,first_seen_at,last_seen_at,"
      "subject_location,event_status,reason,source_results_json,media_type) "
      "VALUES("
      "'EVT-LEGACY','inactivity','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',"
      "'2026-08-01T00:00:00Z','거실','new','legacy row','[]','none');"
      "CREATE TABLE system_state("
      "singleton_id INTEGER PRIMARY KEY,care_state TEXT,camera_state TEXT NOT "
      "NULL,"
      "detection_state TEXT NOT NULL,event_state TEXT NOT NULL,reason TEXT NOT "
      "NULL,"
      "updated_at TEXT NOT NULL);";
  if (version >= 2) {
    sql +=
        "CREATE TABLE managed_items(item_id TEXT PRIMARY KEY,label TEXT NOT "
        "NULL,"
        "policy TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT "
        "NULL);"
        "CREATE TABLE training_samples(sample_id TEXT PRIMARY KEY,item_id TEXT "
        "NOT NULL,"
        "image_path TEXT NOT NULL UNIQUE,captured_at TEXT NOT NULL,width "
        "INTEGER NOT NULL,"
        "height INTEGER NOT NULL,source TEXT NOT NULL DEFAULT 'jetson_camera',"
        "split TEXT NOT NULL DEFAULT 'unassigned');"
        "INSERT INTO managed_items VALUES('legacy-item','legacy "
        "knife','included',"
        "'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');"
        "INSERT INTO "
        "training_samples(sample_id,item_id,image_path,captured_at,width,"
        "height)"
        "VALUES('legacy-sample','legacy-item','legacy.jpg','2026-08-01T00:00:"
        "00Z',640,480);";
  }
  assert(sqlite3_exec(database, sql.c_str(), nullptr, nullptr, nullptr) ==
         SQLITE_OK);
  assert(sqlite3_close(database) == SQLITE_OK);
}

} // namespace

int main() {
  wardy::storage::SqliteStore store(":memory:");
  store.initialize();
  assert(store.journal_mode() == "memory");
  assert(store.schema_version() == "3");

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
  const auto stored_event = store.get_event(event.event_id);
  assert(stored_event.has_value());
  assert(stored_event->reason == event.reason);
  assert(!store.get_event("missing").has_value());

  assert(store.update_event_status(event.event_id, "confirmed",
                                   "2026-08-06T12:01:00+09:00"));
  events = store.list_events();
  assert(events[0].event_status == "confirmed");
  assert(events[0].confirmed_at == "2026-08-06T12:01:00+09:00");
  assert(!store.update_event_status("missing", "confirmed",
                                    "2026-08-06T12:01:00+09:00"));
  auto active_events = store.list_active_events();
  assert(active_events.size() == 1);
  assert(active_events[0].event_id == event.event_id);
  assert(store.update_event_status(event.event_id, "released",
                                   "2026-08-06T12:01:30+09:00"));
  assert(store.list_active_events().empty());
  assert(store.update_event_status(event.event_id, "confirmed",
                                   "2026-08-06T12:01:31+09:00"));
  assert(store.update_event_media(event.event_id, "video", "events/EVT-TEST-001.mp4",
                                  "2026-08-06T11:59:55+09:00",
                                  "2026-08-06T12:00:05+09:00"));
  assert(store.get_event(event.event_id)->media_ended_at ==
         "2026-08-06T12:00:05+09:00");

  wardy::storage::SystemStateRecord state{
      "warning",
      "connected",
      "running",
      "ready",
      "위험물 근접 event 활성",
      "2026-08-06T12:01:00+09:00",
  };
  store.save_system_state(state);
  const auto restored = store.load_system_state();
  assert(restored.has_value());
  assert(restored->care_state == "warning");
  assert(restored->camera_state == "connected");

  const wardy::storage::ManagedItemRecord item{
      "item-knife",
      "주방 칼",
      "included",
      "2026-08-06T12:02:00+09:00",
      "2026-08-06T12:02:00+09:00",
  };
  store.upsert_managed_item(item);
  store.add_training_sample({
      "sample-001",
      item.item_id,
      "items/item-knife/images/sample-001.jpg",
      "2026-08-06T12:03:00+09:00",
      640,
      480,
  });
  assert(store.count_training_samples(item.item_id) == 1);
  const auto items = store.list_managed_items();
  assert(items.size() == 1);
  assert(items[0].sample_count == 1);

  const wardy::storage::SubjectRecord subject{
      "subject-care-01",
      "돌봄 대상",
      "돌봄 대상",
      "2026-08-06T12:04:00+09:00",
      "2026-08-06T12:04:00+09:00",
  };
  store.upsert_subject(subject);
  store.add_subject_reference_sample({
      "subject-sample-001",
      subject.subject_id,
      "subjects/subject-care-01/reference/subject-sample-001.jpg",
      "2026-08-06T12:05:00+09:00",
      640,
      480,
  });
  assert(store.count_subject_reference_samples(subject.subject_id) == 1);
  const auto subjects = store.list_subjects();
  assert(subjects.size() == 1);
  assert(subjects[0].reference_sample_count == 1);

  const auto removed_media = store.clear_event_media(event.event_id);
  assert(removed_media == "events/EVT-TEST-001.mp4");
  assert(store.get_event(event.event_id)->media_type == "none");
  assert(!store.get_event(event.event_id)->media_path.has_value());
  assert(!store.clear_event_media("missing").has_value());

  assert(store.delete_managed_item(item.item_id));
  assert(store.list_managed_items().empty());
  assert(!store.delete_managed_item(item.item_id));
  assert(store.delete_subject(subject.subject_id));
  assert(store.list_subjects().empty());
  assert(!store.delete_subject(subject.subject_id));

  for (const int version : {1, 2}) {
    const auto path = std::filesystem::temp_directory_path() /
                      ("wardy-schema-v" + std::to_string(version) + ".sqlite");
    std::filesystem::remove(path);
    create_version_database(path, version);
    {
      wardy::storage::SqliteStore migrated(path.string());
      migrated.initialize();
      assert(migrated.schema_version() == "3");
      const auto legacy_events = migrated.list_events();
      assert(legacy_events.size() == 1);
      assert(legacy_events[0].event_id == "EVT-LEGACY");
      assert(migrated.count_training_samples("legacy-item") ==
             (version == 2 ? 1U : 0U));
      const std::string suffix = std::to_string(version);
      migrated.upsert_managed_item({
          "migrated-item-" + suffix,
          "migration item",
          "included",
          "2026-08-06T12:10:00+09:00",
          "2026-08-06T12:10:00+09:00",
      });
      migrated.add_training_sample({
          "migrated-sample-" + suffix,
          "migrated-item-" + suffix,
          "items/migrated-" + suffix + ".jpg",
          "2026-08-06T12:11:00+09:00",
          640,
          480,
      });
      assert(migrated.count_training_samples("migrated-item-" + suffix) == 1);
      migrated.upsert_subject({
          "migrated-subject-" + suffix,
          "migration subject",
          "돌봄 대상",
          "2026-08-06T12:12:00+09:00",
          "2026-08-06T12:12:00+09:00",
      });
      migrated.add_subject_reference_sample({
          "migrated-reference-" + suffix,
          "migrated-subject-" + suffix,
          "subjects/migrated-" + suffix + ".jpg",
          "2026-08-06T12:13:00+09:00",
          640,
          480,
      });
      assert(migrated.count_subject_reference_samples("migrated-subject-" +
                                                      suffix) == 1);
    }
    std::filesystem::remove(path);
  }

  const auto retry_path =
      std::filesystem::temp_directory_path() / "wardy-schema-retry.sqlite";
  std::filesystem::remove(retry_path);
  create_version_database(retry_path, 4);
  {
    wardy::storage::SqliteStore retry_store(retry_path.string());
    bool rejected = false;
    try {
      retry_store.initialize();
    } catch (const std::runtime_error &) {
      rejected = true;
    }
    assert(rejected);
    sqlite3 *database = nullptr;
    assert(sqlite3_open(retry_path.string().c_str(), &database) == SQLITE_OK);
    assert(
        sqlite3_exec(
            database,
            "UPDATE schema_metadata SET value='2' WHERE key='schema_version';",
            nullptr, nullptr, nullptr) == SQLITE_OK);
    assert(sqlite3_close(database) == SQLITE_OK);
    retry_store.initialize();
    assert(retry_store.schema_version() == "3");
  }
  std::filesystem::remove(retry_path);
  return 0;
}
