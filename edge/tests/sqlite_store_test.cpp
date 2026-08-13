#include "storage/sqlite_store.hpp"

#undef NDEBUG
#include <algorithm>
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
  assert(store.schema_version() == "7");
  auto privacy = store.data_collection_settings();
  assert(!privacy.identity_review_enabled);
  assert(!privacy.event_media_enabled);
  assert(!privacy.model_improvement_enabled);
  assert(privacy.event_media_retention_days == 7);
  privacy.identity_review_enabled = true;
  privacy.model_improvement_enabled = true;
  privacy.training_data_retention_days = 180;
  privacy.consented_at = "2026-08-13T06:00:00Z";
  privacy.updated_at = *privacy.consented_at;
  store.save_data_collection_settings(privacy);
  const auto saved_privacy = store.data_collection_settings();
  assert(saved_privacy.identity_review_enabled);
  assert(saved_privacy.model_improvement_enabled);
  assert(saved_privacy.training_data_retention_days == 180);

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

  wardy::storage::SqliteStore boundary_store(":memory:");
  boundary_store.initialize();
  auto boundary_event = event;
  boundary_event.event_id = event.event_id;
  boundary_store.upsert_event(boundary_event);
  boundary_event.event_id = "EVT-KST-START";
  boundary_event.occurred_at = "2026-08-05T15:00:00Z";
  boundary_event.first_seen_at = boundary_event.occurred_at;
  boundary_event.last_seen_at = boundary_event.occurred_at;
  boundary_store.upsert_event(boundary_event);
  boundary_event.event_id = "EVT-KST-END";
  boundary_event.occurred_at = "2026-08-06T15:00:00Z";
  boundary_event.first_seen_at = boundary_event.occurred_at;
  boundary_event.last_seen_at = boundary_event.occurred_at;
  boundary_store.upsert_event(boundary_event);
  const auto kst_events = boundary_store.list_events_for_kst_date("2026-08-06");
  assert(kst_events.size() == 2);
  assert(std::any_of(kst_events.begin(), kst_events.end(), [&](const auto& candidate) {
    return candidate.event_id == event.event_id;
  }));
  assert(std::any_of(kst_events.begin(), kst_events.end(), [](const auto& candidate) {
    return candidate.event_id == "EVT-KST-START";
  }));
  assert(std::none_of(kst_events.begin(), kst_events.end(), [](const auto& candidate) {
    return candidate.event_id == "EVT-KST-END";
  }));

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

  store.add_dataset_sample({
      "dataset-sample-001",
      "M-01",
      "DS-001",
      "person",
      "pending",
      "session-0811-am",
      "jetson_camera",
      "datasets/M-01/session-0811-am/dataset-sample-001.jpg",
      std::nullopt,
      "2026-08-11T00:00:00Z",
      640,
      480,
  });
  auto dataset_samples = store.list_dataset_samples();
  assert(dataset_samples.size() == 1);
  assert(dataset_samples[0].model_id == "M-01");
  assert(dataset_samples[0].review_status == "pending");
  const auto stored_dataset_sample = store.get_dataset_sample("dataset-sample-001");
  assert(stored_dataset_sample.has_value());
  assert(stored_dataset_sample->image_path ==
         "datasets/M-01/session-0811-am/dataset-sample-001.jpg");
  assert(!store.get_dataset_sample("missing").has_value());
  assert(store.update_dataset_sample("dataset-sample-001", "care-person", "approved"));
  bool rejected_blank_approved_label = false;
  try {
    store.update_dataset_sample("dataset-sample-001", "   ", "approved");
  } catch (const std::invalid_argument&) {
    rejected_blank_approved_label = true;
  }
  assert(rejected_blank_approved_label);
  dataset_samples = store.list_dataset_samples();
  assert(dataset_samples[0].label == "care-person");
  assert(dataset_samples[0].review_status == "approved");
  bool rejected_blank_approved_insert = false;
  try {
    store.add_dataset_sample({
        "dataset-sample-blank", "M-01", "DS-001", " ", "approved",
        "session-0811-am", "jetson_camera",
        "datasets/M-01/session-0811-am/dataset-sample-blank.jpg", std::nullopt,
        "2026-08-11T00:01:00Z", 640, 480,
    });
  } catch (const std::invalid_argument&) {
    rejected_blank_approved_insert = true;
  }
  assert(rejected_blank_approved_insert);
  assert(store.delete_dataset_sample("dataset-sample-001") ==
         "datasets/M-01/session-0811-am/dataset-sample-001.jpg");
  assert(store.list_dataset_samples().empty());
  assert(!store.delete_dataset_sample("missing").has_value());

  store.upsert_zone({
      "zone-kitchen", "주방 입구", 0.1, 0.2, 0.3, 0.4,
      "2026-08-11T00:00:00Z", "2026-08-11T00:00:00Z",
  });
  auto zones = store.list_zones();
  assert(zones.size() == 1);
  assert(zones[0].name == "주방 입구");
  assert(zones[0].width == 0.3);
  assert(store.delete_zone("zone-kitchen"));
  assert(store.list_zones().empty());
  assert(!store.delete_zone("missing"));

  store.upsert_notification_setting({
      "fall_suspected", false, "2026-08-11T00:00:00Z",
  });
  auto notification_settings = store.list_notification_settings();
  assert(notification_settings.size() == 8);
  auto fall_setting = std::find_if(
      notification_settings.begin(), notification_settings.end(), [](const auto& setting) {
        return setting.event_type == "fall_suspected";
      });
  assert(fall_setting != notification_settings.end());
  assert(!fall_setting->enabled);
  store.upsert_notification_setting({
      "fall_suspected", true, "2026-08-11T00:01:00Z",
  });
  notification_settings = store.list_notification_settings();
  fall_setting = std::find_if(
      notification_settings.begin(), notification_settings.end(), [](const auto& setting) {
        return setting.event_type == "fall_suspected";
      });
  assert(fall_setting != notification_settings.end());
  assert(fall_setting->enabled);

  store.upsert_identity_review({
      "review-1", "identity/review-1.jpg", "2026-08-11T00:02:00Z",
      std::optional<std::string>{"돌봄 대상"}, std::optional<double>{0.54},
      "pending", std::nullopt, "2026-08-11T00:02:00Z",
  });
  auto identity_reviews = store.list_identity_reviews();
  assert(identity_reviews.size() == 1);
  assert(identity_reviews[0].confidence == 0.54);
  assert(store.get_identity_review("review-1").has_value());
  assert(store.update_identity_review_decision(
      "review-1", "subject", subject.subject_id, "2026-08-11T00:03:00Z"));
  identity_reviews = store.list_identity_reviews();
  assert(identity_reviews[0].decision == "subject");
  assert(identity_reviews[0].subject_id == subject.subject_id);
  assert(!store.update_identity_review_decision(
      "missing", "unknown", std::nullopt, "2026-08-11T00:03:00Z"));
  store.upsert_identity_review({
      "review-2", "identity/review-2.jpg", "2026-08-11T00:04:00Z",
      std::nullopt, std::nullopt, "pending", std::nullopt,
      "2026-08-11T00:04:00Z",
  });
  const auto review_without_confidence = store.get_identity_review("review-2");
  assert(review_without_confidence.has_value());
  assert(!review_without_confidence->confidence.has_value());
  assert(!review_without_confidence->predicted_name.has_value());

  const auto removed_media = store.clear_event_media(event.event_id);
  assert(removed_media == "events/EVT-TEST-001.mp4");
  assert(store.get_event(event.event_id)->media_type == "none");
  assert(!store.get_event(event.event_id)->media_path.has_value());
  assert(!store.clear_event_media("missing").has_value());

  assert(store.delete_managed_item(item.item_id));
  assert(store.list_managed_items().empty());
  assert(!store.delete_managed_item(item.item_id));
  assert(store.delete_subject(subject.subject_id));
  assert(!store.get_identity_review("review-1")->subject_id.has_value());
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
      assert(migrated.schema_version() == "7");
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
  create_version_database(retry_path, 8);
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
    assert(retry_store.schema_version() == "7");
  }
  std::filesystem::remove(retry_path);
  return 0;
}
