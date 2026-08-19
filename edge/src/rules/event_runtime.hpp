#pragma once

#include "storage/sqlite_store.hpp"

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace wardy::rules {

struct EventObservation {
  std::string event_type;
  bool active = true;
  std::string observed_at;
  std::optional<std::string> subject_id;
  std::optional<std::string> subject_name;
  std::string subject_location = "unknown";
  std::optional<std::string> object_id;
  std::optional<std::string> object_class;
  std::optional<std::string> zone_id;
  std::string reason;
  std::string source_results_json = "[]";
};

struct EventTransition {
  storage::EventRecord event;
  bool created = false;
  bool released = false;
};

class EventRuntime {
 public:
  using ChangeCallback = std::function<void(const storage::EventRecord&)>;

  explicit EventRuntime(storage::SqliteStore& database,
                        ChangeCallback on_change = {});

  EventTransition apply(const EventObservation& observation);
  bool update_status(const std::string& event_id, const std::string& status,
                     const std::string& changed_at);
  [[nodiscard]] std::optional<std::string> current_care_status() const;
  [[nodiscard]] std::string current_reason() const;

 private:
  static std::string active_key(const EventObservation& observation);
  static std::string active_key(const storage::EventRecord& event);
  static std::optional<std::string> care_status_for(const std::string& event_type);
  static std::string media_type_for(const std::optional<std::string>& care_status);
  static int care_rank(const std::optional<std::string>& care_status);
  std::string next_event_id(const std::string& event_type);
  void restore_active_events();
  void notify_change(const storage::EventRecord& event) const;

  storage::SqliteStore& database_;
  ChangeCallback on_change_;
  mutable std::mutex mutex_;
  std::map<std::string, storage::EventRecord> active_events_;
  std::uint64_t sequence_ = 0;
};

}  // namespace wardy::rules
