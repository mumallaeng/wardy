#pragma once

#include "storage/sqlite_store.hpp"

#include <iomanip>
#include <cctype>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace wardy::api {

inline std::string json_escape(const std::string& value) {
  std::ostringstream escaped;
  escaped << std::hex << std::setfill('0');
  for (const unsigned char character : value) {
    switch (character) {
      case '"': escaped << "\\\""; break;
      case '\\': escaped << "\\\\"; break;
      case '\b': escaped << "\\b"; break;
      case '\f': escaped << "\\f"; break;
      case '\n': escaped << "\\n"; break;
      case '\r': escaped << "\\r"; break;
      case '\t': escaped << "\\t"; break;
      default:
        if (character < 0x20) {
          escaped << "\\u" << std::setw(4) << static_cast<int>(character);
        } else {
          escaped << character;
        }
    }
  }
  return escaped.str();
}

inline std::string json_string(const std::optional<std::string>& value) {
  return value ? "\"" + json_escape(*value) + "\"" : "null";
}

inline std::string json_string(const std::string& value) {
  return "\"" + json_escape(value) + "\"";
}

class JsonValidator {
 public:
  explicit JsonValidator(std::string_view input) : input_(input) {}

  bool array() {
    skip_space();
    const bool valid = value('[');
    skip_space();
    return valid && position_ == input_.size();
  }

 private:
  void skip_space() {
    while (position_ < input_.size() &&
           std::isspace(static_cast<unsigned char>(input_[position_]))) ++position_;
  }

  bool consume(char expected) {
    skip_space();
    if (position_ >= input_.size() || input_[position_] != expected) return false;
    ++position_;
    return true;
  }

  bool value(char required = '\0') {
    skip_space();
    if (position_ >= input_.size() || (required && input_[position_] != required)) return false;
    const char token = input_[position_];
    if (token == '"') return string();
    if (token == '[') return sequence('[', ']');
    if (token == '{') return object();
    if (token == 't') return literal("true");
    if (token == 'f') return literal("false");
    if (token == 'n') return literal("null");
    return number();
  }

  bool sequence(char open, char close) {
    if (!consume(open)) return false;
    if (consume(close)) return true;
    do {
      if (!value()) return false;
    } while (consume(','));
    return consume(close);
  }

  bool object() {
    if (!consume('{')) return false;
    if (consume('}')) return true;
    do {
      if (!string() || !consume(':') || !value()) return false;
    } while (consume(','));
    return consume('}');
  }

  bool string() {
    if (!consume('"')) return false;
    while (position_ < input_.size()) {
      const unsigned char character = static_cast<unsigned char>(input_[position_++]);
      if (character == '"') return true;
      if (character < 0x20) return false;
      if (character != '\\') continue;
      if (position_ >= input_.size()) return false;
      const char escaped = input_[position_++];
      if (std::string_view{"\"\\/bfnrt"}.find(escaped) != std::string_view::npos) continue;
      if (escaped != 'u' || position_ + 4 > input_.size()) return false;
      for (int index = 0; index < 4; ++index) {
        if (!std::isxdigit(static_cast<unsigned char>(input_[position_++]))) return false;
      }
    }
    return false;
  }

  bool literal(std::string_view literal_value) {
    if (input_.substr(position_, literal_value.size()) != literal_value) return false;
    position_ += literal_value.size();
    return true;
  }

  bool number() {
    const std::size_t start = position_;
    if (position_ < input_.size() && input_[position_] == '-') ++position_;
    if (position_ >= input_.size()) return false;
    if (input_[position_] == '0') {
      ++position_;
    } else {
      if (!std::isdigit(static_cast<unsigned char>(input_[position_]))) return false;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
    }
    if (position_ < input_.size() && input_[position_] == '.') {
      ++position_;
      const std::size_t fraction = position_;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
      if (fraction == position_) return false;
    }
    if (position_ < input_.size() && (input_[position_] == 'e' || input_[position_] == 'E')) {
      ++position_;
      if (position_ < input_.size() && (input_[position_] == '+' || input_[position_] == '-')) ++position_;
      const std::size_t exponent = position_;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
      if (exponent == position_) return false;
    }
    return position_ > start;
  }

  std::string_view input_;
  std::size_t position_ = 0;
};

inline bool valid_json_array(const std::string& value) {
  return JsonValidator(value).array();
}

inline std::string event_json(const storage::EventRecord& event) {
  const bool source_is_array = valid_json_array(event.source_results_json);
  return "{" 
      "\"event_id\":" + json_string(event.event_id) +
      ",\"event_type\":" + json_string(event.event_type) +
      ",\"occurred_at\":" + json_string(event.occurred_at) +
      ",\"first_seen_at\":" + json_string(event.first_seen_at) +
      ",\"last_seen_at\":" + json_string(event.last_seen_at) +
      ",\"subject_id\":" + json_string(event.subject_id) +
      ",\"subject_name\":" + json_string(event.subject_name) +
      ",\"subject_location\":" + json_string(event.subject_location) +
      ",\"object_id\":" + json_string(event.object_id) +
      ",\"object_class\":" + json_string(event.object_class) +
      ",\"zone_id\":" + json_string(event.zone_id) +
      ",\"care_status\":" + json_string(event.care_status) +
      ",\"event_status\":" + json_string(event.event_status) +
      ",\"confirmed_at\":" + json_string(event.confirmed_at) +
      ",\"released_at\":" + json_string(event.released_at) +
      ",\"false_detection_at\":" + json_string(event.false_detection_at) +
      ",\"reason\":" + json_string(event.reason) +
      ",\"source_results\":" + (source_is_array ? event.source_results_json : "[]") +
      ",\"media_type\":" + json_string(event.media_type) +
      ",\"media_path\":" + json_string(event.media_path) +
      ",\"media_started_at\":" + json_string(event.media_started_at) +
      ",\"media_ended_at\":" + json_string(event.media_ended_at) + "}";
}

inline std::string event_array_json(const std::vector<storage::EventRecord>& events) {
  std::string body = "[";
  for (std::size_t index = 0; index < events.size(); ++index) {
    if (index > 0) body += ',';
    body += event_json(events[index]);
  }
  return body + "]";
}

inline std::string events_json(const std::vector<storage::EventRecord>& events) {
  return "{\"events\":" + event_array_json(events) + "}";
}

inline std::string state_json(const storage::SystemStateRecord& state) {
  return "{\"care_state\":" + json_string(state.care_state) +
      ",\"camera_state\":" + json_string(state.camera_state) +
      ",\"detection_state\":" + json_string(state.detection_state) +
      ",\"event_state\":" + json_string(state.event_state) +
      ",\"reason\":" + json_string(state.reason) +
      ",\"updated_at\":" + json_string(state.updated_at) + "}";
}

inline std::string runtime_snapshot_json(
    const storage::SystemStateRecord& state,
    const std::vector<storage::EventRecord>& events) {
  return "{\"type\":\"snapshot\",\"state\":" + state_json(state) +
      ",\"events\":" + event_array_json(events) + "}";
}

inline std::string subjects_json(const std::vector<storage::SubjectRecord>& subjects) {
  std::string body = "{\"subjects\":[";
  for (std::size_t index = 0; index < subjects.size(); ++index) {
    if (index > 0) body += ',';
    const auto& subject = subjects[index];
    body += "{\"id\":" + json_string(subject.subject_id) +
        ",\"name\":" + json_string(subject.name) +
        ",\"role\":" + json_string(subject.role) +
        ",\"createdAt\":" + json_string(subject.created_at) +
        ",\"referenceSampleCount\":" +
        std::to_string(subject.reference_sample_count) + "}";
  }
  return body + "]}";
}

inline std::string managed_items_json(
    const std::vector<storage::ManagedItemRecord>& items) {
  std::string body = "{\"managedItems\":[";
  for (std::size_t index = 0; index < items.size(); ++index) {
    if (index > 0) body += ',';
    const auto& item = items[index];
    body += "{\"id\":" + json_string(item.item_id) +
        ",\"label\":" + json_string(item.label) +
        ",\"policy\":" + json_string(item.policy) +
        ",\"sampleCount\":" + std::to_string(item.sample_count) + "}";
  }
  return body + "]}";
}

}  // namespace wardy::api
