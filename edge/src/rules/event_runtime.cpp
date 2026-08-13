#include "rules/event_runtime.hpp"

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <utility>

namespace wardy::rules {
namespace {

bool supported_event_type(const std::string& value) {
  return value == "fall_suspected" || value == "inactivity" ||
         value == "hazard_detected" || value == "hazard_proximity" ||
         value == "zone_entry" || value == "zone_dwell" ||
         value == "camera_fault" || value == "detection_fault";
}

bool terminal_status(const std::string& value) {
  return value == "released" || value == "false_detection";
}

}  // namespace

EventRuntime::EventRuntime(storage::SqliteStore& database,
                           ChangeCallback on_change)
    : database_(database), on_change_(std::move(on_change)) {
  restore_active_events();
}

std::string EventRuntime::active_key(const EventObservation& observation) {
  return observation.subject_id.value_or("system") + "|" + observation.event_type +
         "|" + observation.object_id.value_or("") + "|" +
         observation.zone_id.value_or("");
}

std::string EventRuntime::active_key(const storage::EventRecord& event) {
  return event.subject_id.value_or("system") + "|" + event.event_type + "|" +
         event.object_id.value_or("") + "|" + event.zone_id.value_or("");
}

std::optional<std::string> EventRuntime::care_status_for(
    const std::string& event_type) {
  if (event_type == "fall_suspected") return "emergency";
  if (event_type == "inactivity" || event_type == "hazard_proximity" ||
      event_type == "zone_dwell") return "warning";
  if (event_type == "hazard_detected" || event_type == "zone_entry") {
    return "caution";
  }
  if (event_type == "camera_fault" || event_type == "detection_fault") {
    return "normal";
  }
  throw std::invalid_argument("unsupported event type: " + event_type);
}

std::string EventRuntime::media_type_for(
    const std::optional<std::string>& care_status) {
  if (!care_status || *care_status == "normal") return "none";
  if (*care_status == "caution") return "image";
  return "video";
}

int EventRuntime::care_rank(const std::optional<std::string>& care_status) {
  if (!care_status) return -1;
  if (*care_status == "emergency") return 3;
  if (*care_status == "warning") return 2;
  if (*care_status == "caution") return 1;
  if (*care_status == "normal") return 0;
  return -1;
}

std::string EventRuntime::next_event_id(const std::string& event_type) {
  const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  return "EVT-" + event_type + "-" + std::to_string(milliseconds) + "-" +
         std::to_string(++sequence_);
}

EventTransition EventRuntime::apply(const EventObservation& observation) {
  if (!supported_event_type(observation.event_type)) {
    throw std::invalid_argument("unsupported event type: " + observation.event_type);
  }
  if (observation.observed_at.empty()) {
    throw std::invalid_argument("observation timestamp must not be empty");
  }
  if (observation.reason.empty()) {
    throw std::invalid_argument("observation reason must not be empty");
  }

  EventTransition transition;
  {
    const std::lock_guard lock(mutex_);
    const std::string key = active_key(observation);
    const auto found = active_events_.find(key);
    if (found != active_events_.end()) {
      if (const auto stored = database_.get_event(found->second.event_id)) {
        found->second.media_type = stored->media_type;
        found->second.media_path = stored->media_path;
        found->second.media_started_at = stored->media_started_at;
        found->second.media_ended_at = stored->media_ended_at;
      }
    }

    if (!observation.active) {
      if (found == active_events_.end()) {
        return transition;
      }
      found->second.last_seen_at = observation.observed_at;
      found->second.event_status = "released";
      found->second.released_at = observation.observed_at;
      database_.upsert_event(found->second);
      transition.event = found->second;
      transition.released = true;
      active_events_.erase(found);
    } else if (found != active_events_.end()) {
      found->second.last_seen_at = observation.observed_at;
      found->second.subject_name = observation.subject_name;
      found->second.subject_location = observation.subject_location;
      found->second.object_class = observation.object_class;
      found->second.reason = observation.reason;
      found->second.source_results_json = observation.source_results_json;
      database_.upsert_event(found->second);
      transition.event = found->second;
    } else {
      storage::EventRecord event;
      event.event_id = next_event_id(observation.event_type);
      event.event_type = observation.event_type;
      event.occurred_at = observation.observed_at;
      event.first_seen_at = observation.observed_at;
      event.last_seen_at = observation.observed_at;
      event.subject_id = observation.subject_id;
      event.subject_name = observation.subject_name;
      event.subject_location = observation.subject_location;
      event.object_id = observation.object_id;
      event.object_class = observation.object_class;
      event.zone_id = observation.zone_id;
      event.care_status = care_status_for(observation.event_type);
      event.event_status = "new";
      event.reason = observation.reason;
      event.source_results_json = observation.source_results_json;
      event.media_type = media_type_for(event.care_status);
      database_.upsert_event(event);
      active_events_.emplace(key, event);
      transition.event = std::move(event);
      transition.created = true;
    }
  }
  notify_change(transition.event);
  return transition;
}

bool EventRuntime::update_status(const std::string& event_id,
                                 const std::string& status,
                                 const std::string& changed_at) {
  if (status != "confirmed" && status != "released" &&
      status != "false_detection") {
    throw std::invalid_argument("unsupported event status: " + status);
  }
  bool updated = false;
  std::optional<storage::EventRecord> changed_event;
  {
    const std::lock_guard lock(mutex_);
    const auto stored = database_.get_event(event_id);
    if (!stored) return false;
    if (terminal_status(stored->event_status)) {
      throw std::invalid_argument("terminal event status cannot be changed");
    }
    if (status == "confirmed" && stored->event_status == "confirmed") return true;
    updated = database_.update_event_status(event_id, status, changed_at);
    if (updated && terminal_status(status)) {
      for (auto iterator = active_events_.begin(); iterator != active_events_.end();) {
        if (iterator->second.event_id == event_id) {
          iterator = active_events_.erase(iterator);
        } else {
          ++iterator;
        }
      }
    } else if (updated && status == "confirmed") {
      for (auto& [key, event] : active_events_) {
        (void)key;
        if (event.event_id == event_id) {
          event.event_status = "confirmed";
          event.confirmed_at = changed_at;
        }
      }
    }
    if (updated) changed_event = database_.get_event(event_id);
  }
  if (changed_event) notify_change(*changed_event);
  return updated;
}

bool EventRuntime::has_active_event_type(const std::string& event_type) const {
  const std::lock_guard lock(mutex_);
  return std::any_of(
      active_events_.begin(), active_events_.end(),
      [&event_type](const auto& entry) {
        return entry.second.event_type == event_type;
      });
}

std::optional<std::string> EventRuntime::current_care_status() const {
  const std::lock_guard lock(mutex_);
  std::optional<std::string> current;
  for (const auto& [key, event] : active_events_) {
    (void)key;
    if (event.event_status == "confirmed") continue;
    if (event.event_type == "camera_fault" || event.event_type == "detection_fault") continue;
    if (!event.care_status) continue;
    if (care_rank(event.care_status) > care_rank(current)) current = event.care_status;
  }
  return current.value_or("normal");
}

std::string EventRuntime::current_reason() const {
  const std::lock_guard lock(mutex_);
  const storage::EventRecord* current = nullptr;
  for (const auto& [key, event] : active_events_) {
    (void)key;
    if (event.event_status == "confirmed") continue;
    if (event.event_type == "camera_fault" || event.event_type == "detection_fault") continue;
    if (!event.care_status) continue;
    if (!current || care_rank(event.care_status) > care_rank(current->care_status)) {
      current = &event;
    }
  }
  return current ? current->reason : "활성화된 안전 이벤트가 없습니다.";
}

void EventRuntime::restore_active_events() {
  const std::lock_guard lock(mutex_);
  for (auto& event : database_.list_active_events()) {
    active_events_.insert_or_assign(active_key(event), std::move(event));
  }
}

void EventRuntime::notify_change(const storage::EventRecord& event) const {
  if (on_change_) on_change_(event);
}

}  // namespace wardy::rules
