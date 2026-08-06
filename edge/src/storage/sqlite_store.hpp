#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace wardy::storage {

struct EventRecord {
  std::string event_id;
  std::string event_type;
  std::string occurred_at;
  std::string first_seen_at;
  std::string last_seen_at;
  std::optional<std::string> subject_id;
  std::optional<std::string> subject_name;
  std::string subject_location;
  std::optional<std::string> object_id;
  std::optional<std::string> object_class;
  std::optional<std::string> zone_id;
  std::optional<std::string> care_status;
  std::string event_status;
  std::optional<std::string> confirmed_at;
  std::optional<std::string> released_at;
  std::optional<std::string> false_detection_at;
  std::string reason;
  std::string source_results_json = "[]";
  std::string media_type = "none";
  std::optional<std::string> media_path;
  std::optional<std::string> media_started_at;
  std::optional<std::string> media_ended_at;
};

struct SystemStateRecord {
  std::optional<std::string> care_state;
  std::string camera_state;
  std::string detection_state;
  std::string event_state;
  std::string reason;
  std::string updated_at;
};

struct ManagedItemRecord {
  std::string item_id;
  std::string label;
  std::string policy;
  std::string created_at;
  std::string updated_at;
};

struct TrainingSampleRecord {
  std::string sample_id;
  std::string item_id;
  std::string image_path;
  std::string captured_at;
  int width = 0;
  int height = 0;
};

class SqliteStore {
 public:
  explicit SqliteStore(std::string database_path);
  ~SqliteStore();

  SqliteStore(const SqliteStore&) = delete;
  SqliteStore& operator=(const SqliteStore&) = delete;
  SqliteStore(SqliteStore&&) noexcept;
  SqliteStore& operator=(SqliteStore&&) noexcept;

  void initialize();
  void upsert_event(const EventRecord& event);
  [[nodiscard]] std::vector<EventRecord> list_events(std::size_t limit = 100,
                                                      std::size_t offset = 0) const;
  bool update_event_status(const std::string& event_id, const std::string& event_status,
                           const std::string& changed_at);
  void save_system_state(const SystemStateRecord& state);
  [[nodiscard]] std::optional<SystemStateRecord> load_system_state() const;
  void upsert_managed_item(const ManagedItemRecord& item);
  void add_training_sample(const TrainingSampleRecord& sample);
  [[nodiscard]] std::size_t count_training_samples(const std::string& item_id) const;
  [[nodiscard]] std::string schema_version() const;
  [[nodiscard]] std::string journal_mode() const;
  [[nodiscard]] const std::string& path() const noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace wardy::storage
