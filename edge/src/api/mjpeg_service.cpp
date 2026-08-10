#include "api/mjpeg_service.hpp"

#include "api/http_response.hpp"
#include "api/json_serialization.hpp"
#include "input/camera_capture.hpp"
#include "rules/event_runtime.hpp"
#include "storage/sqlite_store.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <opencv2/core/mat.hpp>
#include <opencv2/imgcodecs.hpp>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <ctime>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>

namespace wardy::api {
namespace {

struct StreamState {
  std::atomic_bool running{true};
  std::atomic_bool camera_connected{false};
  std::atomic_int stream_clients{0};
  std::atomic_int sample_capture_requests{0};
  std::atomic_int frame_width{0};
  std::atomic_int frame_height{0};
  std::atomic_uint64_t sample_counter{0};
  std::shared_ptr<storage::SqliteStore> database;
  std::shared_ptr<rules::EventRuntime> events;
  std::filesystem::path training_data_path;
  std::mutex mutex;
  std::condition_variable frame_ready;
  std::vector<unsigned char> jpeg;
  std::size_t sequence = 0;
  std::string camera_error;
};

std::string lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

std::optional<std::string> request_header(const std::string& request,
                                          const std::string& requested_name) {
  const std::string expected = lowercase(requested_name);
  const std::size_t first_line_end = request.find("\r\n");
  if (first_line_end == std::string::npos) return std::nullopt;
  std::size_t line_start = first_line_end + 2;
  while (line_start < request.size()) {
    const std::size_t line_end = request.find("\r\n", line_start);
    if (line_end == std::string::npos || line_end == line_start) break;
    const std::string line = request.substr(line_start, line_end - line_start);
    const std::size_t separator = line.find(':');
    if (separator != std::string::npos && lowercase(line.substr(0, separator)) == expected) {
      std::size_t value_start = separator + 1;
      while (value_start < line.size() && line[value_start] == ' ') ++value_start;
      return line.substr(value_start);
    }
    line_start = line_end + 2;
  }
  return std::nullopt;
}

int hexadecimal_value(char character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'a' && character <= 'f') return character - 'a' + 10;
  if (character >= 'A' && character <= 'F') return character - 'A' + 10;
  return -1;
}

std::string percent_decode(const std::string& value) {
  std::string decoded;
  decoded.reserve(value.size());
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (value[index] == '%' && index + 2 < value.size()) {
      const int high = hexadecimal_value(value[index + 1]);
      const int low = hexadecimal_value(value[index + 2]);
      if (high < 0 || low < 0) throw std::invalid_argument("invalid encoded item label");
      decoded.push_back(static_cast<char>((high << 4) | low));
      index += 2;
    } else {
      decoded.push_back(value[index]);
    }
  }
  return decoded;
}

bool safe_item_id(const std::string& value) {
  return !value.empty() && value.size() <= 80 &&
         std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return std::isalnum(character) || character == '-' || character == '_';
         });
}

std::string utc_now() {
  const std::time_t now = std::time(nullptr);
  std::tm value{};
#if defined(_WIN32)
  gmtime_s(&value, &now);
#else
  gmtime_r(&now, &value);
#endif
  std::ostringstream stream;
  stream << std::put_time(&value, "%Y-%m-%dT%H:%M:%SZ");
  return stream.str();
}

void save_camera_state(const std::shared_ptr<StreamState>& state,
                       const std::string& camera_state,
                       const std::string& reason) noexcept {
  try {
    const auto previous = state->database->load_system_state();
    state->database->save_system_state({
        previous ? previous->care_state : std::optional<std::string>{"normal"},
        camera_state,
        previous ? previous->detection_state : "disconnected",
        previous ? previous->event_state : "ready",
        reason,
        utc_now(),
    });
  } catch (const std::exception& error) {
    std::cerr << "SQLite state error: " << error.what() << '\n';
  }
}

class StreamClientRegistration {
 public:
  explicit StreamClientRegistration(const std::shared_ptr<StreamState>& state)
      : state_(state) {
    ++state_->stream_clients;
  }
  ~StreamClientRegistration() { --state_->stream_clients; }

  StreamClientRegistration(const StreamClientRegistration&) = delete;
  StreamClientRegistration& operator=(const StreamClientRegistration&) = delete;

 private:
  std::shared_ptr<StreamState> state_;
};

bool send_all(int socket_fd, const void* data, std::size_t size) {
  const auto* bytes = static_cast<const unsigned char*>(data);
  std::size_t sent = 0;
  while (sent < size) {
#ifdef MSG_NOSIGNAL
    const auto count = ::send(socket_fd, bytes + sent, size - sent, MSG_NOSIGNAL);
#else
    const auto count = ::send(socket_fd, bytes + sent, size - sent, 0);
#endif
    if (count <= 0) return false;
    sent += static_cast<std::size_t>(count);
  }
  return true;
}

bool send_text(int socket_fd, const std::string& text) {
  return send_all(socket_fd, text.data(), text.size());
}

bool apply_socket_timeouts(int socket_fd) {
  const timeval timeout{5, 0};
  return ::setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0 &&
         ::setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0;
}

bool origin_allowed(const std::string& request, const std::string& allowed_origin) {
  const auto origin = request_header(request, "origin");
  return !origin || *origin == allowed_origin;
}

bool authorized(const std::string& request, const std::string& access_token) {
  return request_header(request, "x-wardy-access-token").value_or("") == access_token;
}

std::string read_request(int socket_fd) {
  std::string request;
  char buffer[1024];
  while (request.size() < 8192 && request.find("\r\n\r\n") == std::string::npos) {
    const auto count = ::recv(socket_fd, buffer, sizeof(buffer), 0);
    if (count <= 0) break;
    request.append(buffer, static_cast<std::size_t>(count));
  }
  return request;
}

std::pair<std::string, std::string> request_method_path(const std::string& request) {
  const std::size_t method_end = request.find(' ');
  if (method_end == std::string::npos) return {};
  const std::size_t path_end = request.find(' ', method_end + 1);
  if (path_end == std::string::npos) return {};
  return {request.substr(0, method_end),
          request.substr(method_end + 1, path_end - method_end - 1)};
}

std::optional<std::pair<std::string, std::string>> event_action_path(
    const std::string& path) {
  constexpr const char* prefix = "/api/events/";
  if (path.rfind(prefix, 0) != 0) return std::nullopt;
  const std::string remainder = path.substr(std::strlen(prefix));
  const std::size_t separator = remainder.find('/');
  if (separator == std::string::npos) return std::nullopt;
  const std::string event_id = remainder.substr(0, separator);
  const std::string action = remainder.substr(separator + 1);
  if (!safe_item_id(event_id) || action.empty()) return std::nullopt;
  return std::pair{event_id, action};
}

std::optional<std::string> resource_id_path(const std::string& path,
                                            const std::string& prefix) {
  if (path.rfind(prefix, 0) != 0) return std::nullopt;
  const std::string identifier = path.substr(prefix.size());
  if (!safe_item_id(identifier)) return std::nullopt;
  return identifier;
}

std::optional<std::string> decoded_optional_header(const std::string& request,
                                                   const std::string& name) {
  const auto value = request_header(request, name);
  if (!value || value->empty()) return std::nullopt;
  return percent_decode(*value);
}

void save_runtime_state(const std::shared_ptr<StreamState>& state,
                        const std::string& camera_state = "") noexcept {
  try {
    const auto previous = state->database->load_system_state();
    const std::string resolved_camera = !camera_state.empty()
        ? camera_state
        : previous ? previous->camera_state
                   : (state->camera_connected ? "connected" : "idle");
    const auto care = state->events ? state->events->current_care_status()
                                    : std::optional<std::string>{};
    const std::string reason = state->events ? state->events->current_reason()
                                             : "Event runtime is starting";
    state->database->save_system_state({
        care, resolved_camera, "disconnected", "ready", reason, utc_now(),
    });
  } catch (const std::exception& error) {
    std::cerr << "SQLite runtime state error: " << error.what() << '\n';
  }
}

std::string mock_event(const std::string& request,
                       const std::shared_ptr<StreamState>& state) {
  rules::EventObservation observation;
  observation.event_type = request_header(request, "x-wardy-event-type").value_or("");
  observation.active = lowercase(
      request_header(request, "x-wardy-event-active").value_or("true")) != "false";
  observation.observed_at = request_header(request, "x-wardy-observed-at").value_or(utc_now());
  observation.subject_id = decoded_optional_header(request, "x-wardy-subject-id");
  observation.subject_name = decoded_optional_header(request, "x-wardy-subject-name");
  observation.subject_location = decoded_optional_header(
      request, "x-wardy-subject-location").value_or("unknown");
  observation.object_id = decoded_optional_header(request, "x-wardy-object-id");
  observation.object_class = decoded_optional_header(request, "x-wardy-object-class");
  observation.zone_id = decoded_optional_header(request, "x-wardy-zone-id");
  observation.reason = decoded_optional_header(request, "x-wardy-reason")
      .value_or("모델 연결 전 event runtime 검증 입력");
  observation.source_results_json =
      R"([{"source":"mock_contract","note":"AI model is not connected"}])";
  return event_json(state->events->apply(observation).event);
}

std::string create_subject(const std::string& request,
                           const std::shared_ptr<StreamState>& state) {
  const std::string subject_id = request_header(request, "x-wardy-subject-id").value_or("");
  const std::string name = percent_decode(
      request_header(request, "x-wardy-subject-name").value_or(""));
  const std::string role = percent_decode(
      request_header(request, "x-wardy-subject-role").value_or(""));
  if (!safe_item_id(subject_id) || name.empty() || name.size() > 120 ||
      role.empty() || role.size() > 120) {
    throw std::invalid_argument("invalid subject metadata");
  }
  const std::string now = utc_now();
  state->database->upsert_subject({subject_id, name, role, now, now});
  return subjects_json(state->database->list_subjects());
}

std::string create_managed_item(const std::string& request,
                                const std::shared_ptr<StreamState>& state) {
  const std::string item_id = request_header(request, "x-wardy-item-id").value_or("");
  const std::string label = percent_decode(
      request_header(request, "x-wardy-item-label").value_or(""));
  const std::string policy = request_header(request, "x-wardy-item-policy").value_or("");
  if (!safe_item_id(item_id) || label.empty() || label.size() > 120 ||
      (policy != "included" && policy != "excluded")) {
    throw std::invalid_argument("invalid managed item metadata");
  }
  const std::string now = utc_now();
  state->database->upsert_managed_item({item_id, label, policy, now, now});
  return managed_items_json(state->database->list_managed_items());
}

std::string capture_training_sample(const std::string& request,
                                    const std::shared_ptr<StreamState>& state) {
  const std::string item_id = request_header(request, "x-wardy-item-id").value_or("");
  const std::string encoded_label =
      request_header(request, "x-wardy-item-label").value_or("");
  const std::string policy =
      request_header(request, "x-wardy-item-policy").value_or("");
  const std::string label = percent_decode(encoded_label);
  if (!safe_item_id(item_id)) throw std::invalid_argument("invalid managed item ID");
  if (label.empty() || label.size() > 120) {
    throw std::invalid_argument("invalid managed item label");
  }
  if (policy != "included" && policy != "excluded") {
    throw std::invalid_argument("invalid managed item policy");
  }
  if (!state->camera_connected) throw std::runtime_error("Jetson camera is unavailable");

  std::vector<unsigned char> jpeg;
  std::size_t previous_sequence = 0;
  {
    std::lock_guard lock(state->mutex);
    previous_sequence = state->sequence;
  }
  ++state->sample_capture_requests;
  {
    std::unique_lock lock(state->mutex);
    const bool captured = state->frame_ready.wait_for(lock, std::chrono::seconds(3), [&] {
      return !state->running || state->sequence != previous_sequence ||
             !state->camera_error.empty();
    });
    if (!state->camera_error.empty()) {
      throw std::runtime_error("Jetson camera fault: " + state->camera_error);
    }
    if (!captured || state->sequence == previous_sequence || state->jpeg.empty()) {
      throw std::runtime_error("camera sample capture timed out");
    }
    jpeg = state->jpeg;
  }

  const std::string captured_at = utc_now();
  const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string sample_id = "sample-" + std::to_string(timestamp) + "-" +
                                std::to_string(++state->sample_counter);
  const std::filesystem::path relative_path =
      std::filesystem::path("items") / item_id / "images" / (sample_id + ".jpg");
  const std::filesystem::path absolute_path = state->training_data_path / relative_path;
  std::filesystem::create_directories(absolute_path.parent_path());
  {
    std::ofstream output(absolute_path, std::ios::binary);
    if (!output) throw std::runtime_error("failed to create the training sample file");
    output.write(reinterpret_cast<const char*>(jpeg.data()),
                 static_cast<std::streamsize>(jpeg.size()));
    if (!output) throw std::runtime_error("failed to write the training sample file");
  }

  try {
    state->database->upsert_managed_item({
        item_id, label, policy, captured_at, captured_at,
    });
    state->database->add_training_sample({
        sample_id, item_id, relative_path.generic_string(), captured_at,
        state->frame_width, state->frame_height,
    });
    const std::size_t sample_count = state->database->count_training_samples(item_id);
    return "{\"sample_id\":\"" + sample_id + "\",\"image_path\":\"" +
           relative_path.generic_string() + "\",\"sample_count\":" +
           std::to_string(sample_count) + "}";
  } catch (...) {
    std::error_code remove_error;
    std::filesystem::remove(absolute_path, remove_error);
    throw;
  }

}

std::string capture_subject_reference(const std::string& request,
                                      const std::shared_ptr<StreamState>& state) {
  const std::string subject_id =
      request_header(request, "x-wardy-subject-id").value_or("");
  const std::string name = percent_decode(
      request_header(request, "x-wardy-subject-name").value_or(""));
  const std::string role = percent_decode(
      request_header(request, "x-wardy-subject-role").value_or(""));
  if (!safe_item_id(subject_id)) throw std::invalid_argument("invalid subject ID");
  if (name.empty() || name.size() > 120) {
    throw std::invalid_argument("invalid subject name");
  }
  if (role.empty() || role.size() > 120) {
    throw std::invalid_argument("invalid subject role");
  }
  if (!state->camera_connected) throw std::runtime_error("Jetson camera is unavailable");

  std::vector<unsigned char> jpeg;
  std::size_t previous_sequence = 0;
  {
    std::lock_guard lock(state->mutex);
    previous_sequence = state->sequence;
  }
  ++state->sample_capture_requests;
  {
    std::unique_lock lock(state->mutex);
    const bool captured = state->frame_ready.wait_for(lock, std::chrono::seconds(3), [&] {
      return !state->running || state->sequence != previous_sequence ||
             !state->camera_error.empty();
    });
    if (!state->camera_error.empty()) {
      throw std::runtime_error("Jetson camera fault: " + state->camera_error);
    }
    if (!captured || state->sequence == previous_sequence || state->jpeg.empty()) {
      throw std::runtime_error("camera subject reference capture timed out");
    }
    jpeg = state->jpeg;
  }

  const std::string captured_at = utc_now();
  const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string sample_id = "subject-sample-" + std::to_string(timestamp) + "-" +
                                std::to_string(++state->sample_counter);
  const std::filesystem::path relative_path = std::filesystem::path("subjects") /
      subject_id / "reference" / (sample_id + ".jpg");
  const std::filesystem::path absolute_path = state->training_data_path / relative_path;
  std::filesystem::create_directories(absolute_path.parent_path());
  {
    std::ofstream output(absolute_path, std::ios::binary);
    if (!output) throw std::runtime_error("failed to create the subject reference file");
    output.write(reinterpret_cast<const char*>(jpeg.data()),
                 static_cast<std::streamsize>(jpeg.size()));
    if (!output) throw std::runtime_error("failed to write the subject reference file");
  }

  try {
    state->database->upsert_subject({
        subject_id, name, role, captured_at, captured_at,
    });
    state->database->add_subject_reference_sample({
        sample_id, subject_id, relative_path.generic_string(), captured_at,
        state->frame_width, state->frame_height,
    });
    const std::size_t sample_count =
        state->database->count_subject_reference_samples(subject_id);
    return "{\"sample_id\":\"" + sample_id + "\",\"image_path\":\"" +
           relative_path.generic_string() + "\",\"sample_count\":" +
           std::to_string(sample_count) + "}";
  } catch (...) {
    std::error_code remove_error;
    std::filesystem::remove(absolute_path, remove_error);
    throw;
  }

}

void serve_stream(int socket_fd, const std::shared_ptr<StreamState>& state,
                  const std::string& allowed_origin) {
  const StreamClientRegistration registration(state);
  {
    std::unique_lock lock(state->mutex);
    state->frame_ready.wait_for(lock, std::chrono::seconds(3), [&] {
      return !state->running || !state->jpeg.empty() || !state->camera_error.empty();
    });
    if (state->jpeg.empty()) {
      send_text(socket_fd, json_response(503, "Service Unavailable",
                                         "{\"error\":\"Jetson camera is unavailable\"}",
                                         allowed_origin));
      return;
    }
  }

  if (!send_text(socket_fd, mjpeg_headers(allowed_origin))) return;

  std::size_t last_sequence = 0;
  while (state->running) {
    std::vector<unsigned char> jpeg;
    {
      std::unique_lock lock(state->mutex);
      state->frame_ready.wait_for(lock, std::chrono::seconds(2), [&] {
        return !state->running || state->sequence != last_sequence;
      });
      if (!state->running) break;
      if (state->sequence == last_sequence || state->jpeg.empty()) continue;
      jpeg = state->jpeg;
      last_sequence = state->sequence;
    }

    if (!send_text(socket_fd, mjpeg_frame_header(jpeg.size())) ||
        !send_all(socket_fd, jpeg.data(), jpeg.size()) ||
        !send_text(socket_fd, "\r\n")) {
      break;
    }
  }
}

void handle_client(int socket_fd, const std::shared_ptr<StreamState>& state,
                   const MjpegServiceConfig config) {
  if (!apply_socket_timeouts(socket_fd)) {
    ::close(socket_fd);
    return;
  }
  const std::string request = read_request(socket_fd);
  const auto [method, path] = request_method_path(request);
  try {
  const bool protected_api = path.rfind("/api/", 0) == 0 && path != "/api/health";
  if (method == "OPTIONS") {
    if (origin_allowed(request, config.allowed_origin)) {
      send_text(socket_fd, options_response(config.allowed_origin));
    } else {
      send_text(socket_fd, json_response(403, "Forbidden", "{\"error\":\"Origin denied\"}",
                                         config.allowed_origin));
    }
  } else if (protected_api &&
             (!origin_allowed(request, config.allowed_origin) ||
              !authorized(request, config.access_token))) {
    send_text(socket_fd, json_response(403, "Forbidden", "{\"error\":\"Access denied\"}",
                                       config.allowed_origin));
  } else if (method == "GET" && path == "/api/health") {
    send_text(socket_fd, health_response(state->camera_connected, config.allowed_origin));
  } else if (method == "GET" && path == "/api/camera/stream") {
    serve_stream(socket_fd, state, config.allowed_origin);
  } else if (method == "GET" && path == "/api/events") {
    send_text(socket_fd, json_response(200, "OK",
        events_json(state->database->list_events()), config.allowed_origin));
  } else if (method == "GET" && path == "/api/state") {
    const auto current = state->database->load_system_state();
    if (!current) {
      send_text(socket_fd, json_response(404, "Not Found",
          "{\"error\":\"State not initialized\"}", config.allowed_origin));
    } else {
      send_text(socket_fd, json_response(200, "OK", state_json(*current),
                                         config.allowed_origin));
    }
  } else if (method == "POST" && path == "/api/debug/events") {
    try {
      send_text(socket_fd, json_response(201, "Created", mock_event(request, state),
                                         config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
  } else if (method == "POST" && event_action_path(path)) {
    const auto [event_id, action] = *event_action_path(path);
    const std::string status = action == "confirm" ? "confirmed" :
                               action == "release" ? "released" :
                               action == "false-detection" ? "false_detection" : "";
    if (status.empty()) {
      send_text(socket_fd, json_response(404, "Not Found", "{\"error\":\"Unknown action\"}",
                                         config.allowed_origin));
    } else if (!state->events->update_status(event_id, status, utc_now())) {
      send_text(socket_fd, json_response(404, "Not Found", "{\"error\":\"Event not found\"}",
                                         config.allowed_origin));
    } else if (const auto event = state->database->get_event(event_id)) {
      send_text(socket_fd, json_response(200, "OK",
          event_json(*event), config.allowed_origin));
    } else {
      send_text(socket_fd, json_response(404, "Not Found", "{\"error\":\"Event not found\"}",
                                         config.allowed_origin));
    }
  } else if (method == "GET" && path == "/api/subjects") {
    send_text(socket_fd, json_response(200, "OK",
        subjects_json(state->database->list_subjects()), config.allowed_origin));
  } else if (method == "POST" && path == "/api/subjects") {
    try {
      send_text(socket_fd, json_response(201, "Created", create_subject(request, state),
                                         config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
  } else if (method == "DELETE" && resource_id_path(path, "/api/subjects/")) {
    const std::string subject_id = *resource_id_path(path, "/api/subjects/");
    const bool deleted = state->database->delete_subject(subject_id);
    if (deleted) {
      std::error_code error;
      std::filesystem::remove_all(state->training_data_path / "subjects" / subject_id, error);
    }
    send_text(socket_fd, json_response(deleted ? 200 : 404, deleted ? "OK" : "Not Found",
        subjects_json(state->database->list_subjects()), config.allowed_origin));
  } else if (method == "GET" && path == "/api/managed-items") {
    send_text(socket_fd, json_response(200, "OK",
        managed_items_json(state->database->list_managed_items()), config.allowed_origin));
  } else if (method == "POST" && path == "/api/managed-items") {
    try {
      send_text(socket_fd, json_response(201, "Created", create_managed_item(request, state),
                                         config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
  } else if (method == "DELETE" && resource_id_path(path, "/api/managed-items/")) {
    const std::string item_id = *resource_id_path(path, "/api/managed-items/");
    const bool deleted = state->database->delete_managed_item(item_id);
    if (deleted) {
      std::error_code error;
      std::filesystem::remove_all(state->training_data_path / "items" / item_id, error);
    }
    send_text(socket_fd, json_response(deleted ? 200 : 404, deleted ? "OK" : "Not Found",
        managed_items_json(state->database->list_managed_items()), config.allowed_origin));
  } else if (method == "POST" && path == "/api/training/items/sample") {
    try {
      send_text(socket_fd, json_response(201, "Created",
                                         capture_training_sample(request, state), config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
                                         "{\"error\":\"" + json_escape(error.what()) + "\"}",
                                         config.allowed_origin));
    } catch (const std::exception& error) {
      send_text(socket_fd, json_response(503, "Service Unavailable",
                                         "{\"error\":\"" + json_escape(error.what()) + "\"}",
                                         config.allowed_origin));
    }
  } else if (method == "POST" && path == "/api/training/subjects/reference") {
    try {
      send_text(socket_fd, json_response(201, "Created",
                                         capture_subject_reference(request, state), config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
                                         "{\"error\":\"" + json_escape(error.what()) + "\"}",
                                         config.allowed_origin));
    } catch (const std::exception& error) {
      send_text(socket_fd, json_response(503, "Service Unavailable",
                                         "{\"error\":\"" + json_escape(error.what()) + "\"}",
                                         config.allowed_origin));
    }
  } else {
    send_text(socket_fd, json_response(404, "Not Found", "{\"error\":\"Not found\"}",
                                       config.allowed_origin));
  }
  } catch (const std::invalid_argument& error) {
    send_text(socket_fd, json_response(400, "Bad Request",
        "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
  } catch (const std::exception& error) {
    std::cerr << "Wardy API error: " << error.what() << '\n';
    send_text(socket_fd, json_response(500, "Internal Server Error",
        "{\"error\":\"Request failed\"}", config.allowed_origin));
  }
  ::close(socket_fd);
}

void capture_frames(const MjpegServiceConfig& config,
                    const std::shared_ptr<StreamState>& state) {
  auto retry_delay = std::chrono::seconds(1);
  constexpr auto maximum_retry_delay = std::chrono::seconds(30);
  std::string last_reported_error;
  while (state->running) {
    try {
      input::CameraCapture camera(config.camera);
      camera.open();
      cv::Mat frame;
      const std::vector<int> encode_parameters{cv::IMWRITE_JPEG_QUALITY,
                                                config.jpeg_quality};
      auto next_preview_at = std::chrono::steady_clock::now();
      bool connected_reported = false;
      while (state->running) {
        if (!camera.read(frame)) {
          throw std::runtime_error("failed to read a frame from the Jetson camera");
        }
        if (!connected_reported) {
          {
            std::lock_guard lock(state->mutex);
            state->camera_error.clear();
          }
          state->camera_connected = true;
          save_camera_state(state, "connected", "Jetson camera frame input is ready");
          retry_delay = std::chrono::seconds(1);
          last_reported_error.clear();
          connected_reported = true;
        }
        state->frame_width = frame.cols;
        state->frame_height = frame.rows;
        const int served_requests = state->sample_capture_requests.load();
        if (state->stream_clients == 0 && served_requests == 0) continue;

        const auto now = std::chrono::steady_clock::now();
        if (now < next_preview_at) continue;
        next_preview_at = now + std::chrono::milliseconds(100);

        std::vector<unsigned char> encoded;
        if (!cv::imencode(".jpg", frame, encoded, encode_parameters)) {
          throw std::runtime_error("failed to encode the Jetson camera frame");
        }
        {
          std::lock_guard lock(state->mutex);
          state->jpeg = std::move(encoded);
          ++state->sequence;
        }
        state->sample_capture_requests.fetch_sub(served_requests);
        state->frame_ready.notify_all();
      }
      camera.close();
    } catch (const std::exception& error) {
      state->camera_connected = false;
      {
        std::lock_guard lock(state->mutex);
        state->camera_error = error.what();
      }
      state->frame_ready.notify_all();
      if (last_reported_error != error.what()) {
        last_reported_error = error.what();
        save_camera_state(state, "fault", error.what());
        std::cerr << "Jetson camera error: " << error.what() << '\n';
      }
      if (state->running) std::this_thread::sleep_for(retry_delay);
      retry_delay = std::min(retry_delay * 2, maximum_retry_delay);
    }
  }
}

int open_server_socket(int port) {
  const int socket_fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd < 0) throw std::runtime_error("failed to create the HTTP socket");

  int reuse = 1;
  if (::setsockopt(socket_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
    ::close(socket_fd);
    throw std::runtime_error("failed to configure the HTTP socket");
  }

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons(static_cast<std::uint16_t>(port));
  if (::bind(socket_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0 ||
      ::listen(socket_fd, 8) < 0) {
    const std::string message = std::strerror(errno);
    ::close(socket_fd);
    throw std::runtime_error("failed to listen on the HTTP port: " + message);
  }
  return socket_fd;
}

}  // namespace

void MjpegServiceConfig::validate() const {
  camera.validate();
  if (port < 1 || port > 65535) throw std::invalid_argument("port must be between 1 and 65535");
  if (jpeg_quality < 1 || jpeg_quality > 100) throw std::invalid_argument("jpeg quality must be between 1 and 100");
  if (database_path.empty()) throw std::invalid_argument("database path must not be empty");
  if (training_data_path.empty()) throw std::invalid_argument("training data path must not be empty");
  if (allowed_origin.empty()) throw std::invalid_argument("allowed UI origin must not be empty");
  if (allowed_origin.find_first_of("\r\n") != std::string::npos ||
      (allowed_origin.rfind("http://", 0) != 0 && allowed_origin.rfind("https://", 0) != 0)) {
    throw std::invalid_argument("allowed UI origin must be an HTTP(S) origin");
  }
  if (access_token.empty()) throw std::invalid_argument("WARDY_ACCESS_TOKEN must not be empty");
}

MjpegService::MjpegService(MjpegServiceConfig config) : config_(std::move(config)) {
  config_.validate();
}

int MjpegService::run(const std::atomic_bool& stop_requested) {
  const auto state = std::make_shared<StreamState>();
  state->database = std::make_shared<storage::SqliteStore>(config_.database_path);
  state->database->initialize();
  state->training_data_path = config_.training_data_path;
  const std::weak_ptr<StreamState> weak_state = state;
  state->events = std::make_shared<rules::EventRuntime>(
      *state->database, [weak_state] {
        if (const auto locked = weak_state.lock()) save_runtime_state(locked);
      });
  const int server_fd = open_server_socket(config_.port);
  save_camera_state(state, "connecting", "Jetson camera connection is starting");
  std::thread capture_thread(capture_frames, std::cref(config_), state);
  std::cout << "Wardy edge service listening on 127.0.0.1:" << config_.port << '\n';

  while (!stop_requested) {
    fd_set read_set;
    FD_ZERO(&read_set);
    FD_SET(server_fd, &read_set);
    timeval timeout{0, 250000};
    const int ready = ::select(server_fd + 1, &read_set, nullptr, nullptr, &timeout);
    if (ready <= 0) continue;

    const int client_fd = ::accept(server_fd, nullptr, nullptr);
    if (client_fd >= 0) {
      std::thread(handle_client, client_fd, state, config_).detach();
    }
  }

  state->running = false;
  state->frame_ready.notify_all();
  ::close(server_fd);
  if (capture_thread.joinable()) capture_thread.join();
  save_camera_state(state, "idle", "Wardy edge service stopped");
  return 0;
}

}  // namespace wardy::api
