#include "api/mjpeg_service.hpp"

#include "api/http_response.hpp"
#include "api/json_serialization.hpp"
#include "api/request_security.hpp"
#include "api/websocket.hpp"
#include "input/camera_capture.hpp"
#include "inference/inference_output.hpp"
#include "llm/daily_summary.hpp"
#include "media/event_media.hpp"
#include "rules/event_runtime.hpp"
#include "storage/sqlite_store.hpp"

#if defined(WARDY_WITH_TENSORRT)
#include "inference/person_inference_runtime.hpp"
#include "inference/pose_fall_client.hpp"
#endif

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
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <ctime>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <memory>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <sstream>
#include <thread>
#include <tuple>
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
  std::atomic_uint64_t inference_counter{0};
  std::atomic_bool detection_running_reported{false};
  std::atomic_bool detection_fault_active{false};
  std::mutex system_state_mutex;
  std::mutex active_fall_tracks_mutex;
  std::set<std::int64_t> active_fall_tracks;
  std::map<std::int64_t,
           std::pair<std::optional<std::string>, std::optional<std::string>>>
      active_fall_identities;
  std::mutex model_people_mutex;
  std::map<std::int64_t, inference::PersonOutput> model_people;
  std::shared_ptr<storage::SqliteStore> database;
  std::shared_ptr<rules::EventRuntime> events;
  std::shared_ptr<inference::InferenceOutputRuntime> inference;
  std::shared_ptr<inference::TemporaryInferenceProducer> temporary_inference;
  std::shared_ptr<media::EventMediaRecorder> event_media;
  std::shared_ptr<llm::DailySummaryService> daily_summary;
  std::mutex daily_summary_mutex;
  std::filesystem::path training_data_path;
  std::mutex websocket_mutex;
  std::mutex websocket_send_mutex;
  std::vector<int> websocket_clients;
  std::size_t websocket_reservations = 0;
  std::mutex mutex;
  std::condition_variable frame_ready;
  std::vector<unsigned char> jpeg;
  std::size_t sequence = 0;
  std::string camera_error;
#if defined(WARDY_WITH_TENSORRT)
  std::shared_ptr<inference::PersonInferenceRuntime> person_inference;
#endif
};

void broadcast_snapshot(const std::shared_ptr<StreamState>& state) noexcept;
void broadcast_inference(const std::shared_ptr<StreamState>& state) noexcept;

void schedule_event_media(const std::shared_ptr<StreamState>& state,
                          const storage::EventRecord& event) noexcept {
  try {
    if (!state->event_media) return;
    if (!state->database->data_collection_settings().event_media_enabled) return;
    state->event_media->schedule(event);
  } catch (const std::exception& error) {
    std::cerr << "Event media scheduling error: " << error.what() << '\n';
  }
}

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

bool configurable_event_type(const std::string& value) {
  return value == "fall_suspected" || value == "inactivity" ||
      value == "hazard_detected" || value == "hazard_proximity" ||
      value == "zone_entry" || value == "zone_dwell" ||
      value == "camera_fault" || value == "detection_fault";
}

double normalized_coordinate(const std::string& value) {
  std::size_t parsed = 0;
  double result = 0.0;
  try {
    result = std::stod(value, &parsed);
  } catch (const std::out_of_range&) {
    throw std::invalid_argument("invalid normalized zone coordinate");
  }
  if (parsed != value.size() || !std::isfinite(result) || result < 0.0 || result > 1.0) {
    throw std::invalid_argument("invalid normalized zone coordinate");
  }
  return result;
}

bool valid_summary_date(const std::string& value) {
  if (value.size() != 10 || value[4] != '-' || value[7] != '-') return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 4 || index == 7) continue;
    if (!std::isdigit(static_cast<unsigned char>(value[index]))) return false;
  }
  const int year = std::stoi(value.substr(0, 4));
  const int month = std::stoi(value.substr(5, 2));
  const int day = std::stoi(value.substr(8, 2));
  if (month < 1 || month > 12) return false;
  constexpr int days_by_month[] = {0, 31, 28, 31, 30, 31, 30,
                                    31, 31, 30, 31, 30, 31};
  int maximum_day = days_by_month[month];
  const bool leap_year = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  if (month == 2 && leap_year) maximum_day = 29;
  return day >= 1 && day <= maximum_day;
}

std::string daily_summary_json(const llm::DailySummaryResult& result) {
  return "{\"summary\":" + json_string(result.summary) +
      ",\"model\":" + json_string(result.model) +
      ",\"fallback\":" + (result.fallback ? "true" : "false") +
      ",\"filtered\":" + (result.filtered ? "true" : "false") +
      ",\"fallback_reason\":" + json_string(result.fallback_reason) +
      ",\"event_count\":" + std::to_string(result.event_count) +
      ",\"unconfirmed_count\":" + std::to_string(result.unconfirmed_count) +
      ",\"duration_ms\":" + std::to_string(result.duration_ms) + "}";
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

std::string kst_date_now() {
  const std::time_t now = std::time(nullptr) + 9 * 60 * 60;
  std::tm value{};
#if defined(_WIN32)
  gmtime_s(&value, &now);
#else
  gmtime_r(&now, &value);
#endif
  std::ostringstream stream;
  stream << std::put_time(&value, "%Y-%m-%d");
  return stream.str();
}

void save_camera_state(const std::shared_ptr<StreamState>& state,
                       const std::string& camera_state,
                       const std::string& reason) noexcept {
  try {
    {
      std::lock_guard lock(state->system_state_mutex);
      const auto previous = state->database->load_system_state();
      const bool preserve_event_reason = previous && previous->care_state &&
          *previous->care_state != "normal" && camera_state == "connected";
      state->database->save_system_state({
          previous ? previous->care_state : std::optional<std::string>{"normal"},
          camera_state,
          previous ? previous->detection_state : "disconnected",
          previous ? previous->event_state : "ready",
          preserve_event_reason ? previous->reason : reason,
          utc_now(),
      });
    }
    broadcast_snapshot(state);
  } catch (const std::exception& error) {
    std::cerr << "SQLite state error: " << error.what() << '\n';
  }
}

void save_detection_state(const std::shared_ptr<StreamState>& state,
                          const std::string& detection_state,
                          const std::string& reason) noexcept {
  try {
    {
      std::lock_guard lock(state->system_state_mutex);
      const auto previous = state->database->load_system_state();
      const bool preserve_event_reason = previous && previous->care_state &&
          *previous->care_state != "normal" && detection_state != "fault";
      state->database->save_system_state({
          previous ? previous->care_state : std::optional<std::string>{"normal"},
          previous ? previous->camera_state : "idle", detection_state,
          previous ? previous->event_state : "ready",
          preserve_event_reason ? previous->reason : reason, utc_now(),
      });
    }
    broadcast_snapshot(state);
  } catch (const std::exception& error) {
    std::cerr << "SQLite detection state error: " << error.what() << '\n';
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

bool send_binary_response(int socket_fd, const std::vector<unsigned char>& body,
                          const std::string& content_type,
                          const std::string& allowed_origin) {
  const std::string headers = "HTTP/1.1 200 OK\r\n" + common_headers(allowed_origin) +
      "Content-Type: " + content_type + "\r\nContent-Length: " +
      std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n";
  return send_text(socket_fd, headers) && send_all(socket_fd, body.data(), body.size());
}

std::optional<std::string> runtime_snapshot(
    const std::shared_ptr<StreamState>& state) {
  const auto system = state->database->load_system_state();
  if (!system) return std::nullopt;
  auto events = state->database->list_events();
  const auto active_events = state->database->list_active_events();
  for (const auto& active : active_events) {
    const auto found = std::find_if(events.begin(), events.end(), [&](const auto& event) {
      return event.event_id == active.event_id;
    });
    if (found == events.end()) events.push_back(active);
  }
  return runtime_snapshot_json(*system, events);
}

std::vector<storage::EventRecord> api_events(
    const std::shared_ptr<StreamState>& state) {
  auto events = state->database->list_events();
  const auto active_events = state->database->list_active_events();
  for (const auto& active : active_events) {
    const auto found = std::find_if(events.begin(), events.end(), [&](const auto& event) {
      return event.event_id == active.event_id;
    });
    if (found == events.end()) events.push_back(active);
  }
  return events;
}

void broadcast_payload(const std::shared_ptr<StreamState>& state,
                       const std::string& payload) {
  const std::string frame = websocket_text_frame(payload);
  std::vector<int> clients;
  {
    std::lock_guard lock(state->websocket_mutex);
    clients = state->websocket_clients;
  }
  std::vector<int> failed;
  {
    std::lock_guard send_lock(state->websocket_send_mutex);
    for (const int client : clients) {
      if (!send_all(client, frame.data(), frame.size())) failed.push_back(client);
    }
  }
  if (!failed.empty()) {
    std::lock_guard lock(state->websocket_mutex);
    state->websocket_clients.erase(
        std::remove_if(state->websocket_clients.begin(), state->websocket_clients.end(),
            [&](int client) {
              return std::find(failed.begin(), failed.end(), client) != failed.end();
            }),
        state->websocket_clients.end());
  }
}

void broadcast_snapshot(const std::shared_ptr<StreamState>& state) noexcept {
  try {
    const auto snapshot = runtime_snapshot(state);
    if (!snapshot) return;
    broadcast_payload(state, *snapshot);
  } catch (const std::exception& error) {
    std::cerr << "WebSocket broadcast error: " << error.what() << '\n';
  }
}

void broadcast_inference(const std::shared_ptr<StreamState>& state) noexcept {
  try {
    if (!state->inference) return;
    broadcast_payload(state, inference::inference_message_json(state->inference->snapshot()));
  } catch (const std::exception& error) {
    std::cerr << "Inference broadcast error: " << error.what() << '\n';
  }
}

void remove_websocket_client(const std::shared_ptr<StreamState>& state,
                             int socket_fd) {
  std::lock_guard lock(state->websocket_mutex);
  state->websocket_clients.erase(
      std::remove(state->websocket_clients.begin(), state->websocket_clients.end(), socket_fd),
      state->websocket_clients.end());
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

bool websocket_authorized(const std::string& request,
                          const std::string& access_token) {
  const std::string protocols = request_header(request, "sec-websocket-protocol")
      .value_or("");
  std::istringstream stream(protocols);
  std::string protocol;
  bool wardy_protocol = false;
  bool token = false;
  while (std::getline(stream, protocol, ',')) {
    protocol.erase(protocol.begin(), std::find_if(protocol.begin(), protocol.end(),
        [](unsigned char value) { return !std::isspace(value); }));
    protocol.erase(std::find_if(protocol.rbegin(), protocol.rend(),
        [](unsigned char value) { return !std::isspace(value); }).base(), protocol.end());
    wardy_protocol = wardy_protocol || protocol == "wardy-events";
    token = token || protocol == access_token;
  }
  return wardy_protocol && token;
}

std::string read_request(int socket_fd) {
  std::string request;
  char buffer[4096];
  constexpr std::size_t maximum_header_size = 16 * 1024;
  constexpr std::size_t maximum_body_size = 8 * 1024 * 1024;
  while (request.size() < maximum_header_size &&
         request.find("\r\n\r\n") == std::string::npos) {
    const auto count = ::recv(socket_fd, buffer, sizeof(buffer), 0);
    if (count <= 0) break;
    request.append(buffer, static_cast<std::size_t>(count));
  }
  const std::size_t header_end = request.find("\r\n\r\n");
  if (header_end == std::string::npos) return request;
  const auto raw_length = request_header(request, "content-length");
  if (!raw_length) return request;
  std::size_t body_size = 0;
  try {
    std::size_t parsed = 0;
    body_size = std::stoull(*raw_length, &parsed);
    if (parsed != raw_length->size() || body_size > maximum_body_size) return request;
  } catch (...) {
    return request;
  }
  const std::size_t expected_size = header_end + 4 + body_size;
  while (request.size() < expected_size) {
    const std::size_t remaining = expected_size - request.size();
    const auto count = ::recv(socket_fd, buffer, std::min(sizeof(buffer), remaining), 0);
    if (count <= 0) break;
    request.append(buffer, static_cast<std::size_t>(count));
  }
  return request;
}

std::string request_body(const std::string& request) {
  constexpr std::size_t maximum_body_size = 8 * 1024 * 1024;
  const std::size_t header_end = request.find("\r\n\r\n");
  if (header_end == std::string::npos) throw std::invalid_argument("missing request headers");
  const auto raw_length = request_header(request, "content-length");
  if (!raw_length) throw std::invalid_argument("missing content length");
  std::size_t parsed = 0;
  const std::size_t body_size = std::stoull(*raw_length, &parsed);
  if (parsed != raw_length->size() || body_size == 0 || body_size > maximum_body_size) {
    throw std::invalid_argument("invalid image body size");
  }
  const std::size_t body_start = header_end + 4;
  if (request.size() < body_start + body_size) {
    throw std::invalid_argument("incomplete image body");
  }
  return request.substr(body_start, body_size);
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

std::optional<std::string> event_media_path(const std::string& path) {
  const auto action = event_action_path(path);
  if (!action || action->second != "media") return std::nullopt;
  return action->first;
}

std::optional<std::string> resource_media_path(const std::string& path,
                                               const std::string& prefix) {
  if (path.rfind(prefix, 0) != 0) return std::nullopt;
  const std::string remainder = path.substr(prefix.size());
  const std::size_t separator = remainder.find('/');
  if (separator == std::string::npos || remainder.substr(separator + 1) != "media") {
    return std::nullopt;
  }
  const std::string identifier = remainder.substr(0, separator);
  return safe_item_id(identifier) ? std::optional<std::string>{identifier} : std::nullopt;
}

std::optional<std::string> dataset_sample_media_path(const std::string& path) {
  return resource_media_path(path, "/api/data-samples/");
}

std::optional<std::string> identity_review_media_path(const std::string& path) {
  return resource_media_path(path, "/api/identity-reviews/");
}

std::filesystem::path stored_media_file(const std::shared_ptr<StreamState>& state,
                                        const storage::EventRecord& event) {
  if (!event.media_path) throw std::invalid_argument("event media is not ready");
  const std::filesystem::path relative(*event.media_path);
  if (relative.empty() || relative.has_parent_path() || relative.filename() != relative) {
    throw std::runtime_error("invalid event media path in SQLite");
  }
  return state->event_media->root_path() / relative;
}

std::filesystem::path resolve_under_training_root(
    const std::shared_ptr<StreamState>& state, const std::string& image_path,
    const char* invalid_path_message, const char* escape_message) {
  const std::filesystem::path relative(image_path);
  if (relative.empty() || relative.is_absolute()) {
    throw std::runtime_error(invalid_path_message);
  }
  const std::filesystem::path root =
      std::filesystem::weakly_canonical(state->training_data_path);
  const std::filesystem::path candidate =
      std::filesystem::weakly_canonical(root / relative);
  const auto [root_end, candidate_end] = std::mismatch(
      root.begin(), root.end(), candidate.begin(), candidate.end());
  (void)candidate_end;
  if (root_end != root.end()) {
    throw std::runtime_error(escape_message);
  }
  return candidate;
}

std::filesystem::path stored_dataset_file(
    const std::shared_ptr<StreamState>& state,
    const storage::DatasetSampleRecord& sample) {
  return resolve_under_training_root(
      state, sample.image_path, "invalid dataset image path in SQLite",
      "dataset image path escapes storage root");
}

std::filesystem::path stored_identity_review_file(
    const std::shared_ptr<StreamState>& state,
    const storage::IdentityReviewRecord& review) {
  return resolve_under_training_root(
      state, review.image_path, "invalid identity review image path in SQLite",
      "identity review image path escapes storage root");
}

std::string dataset_image_content_type(const std::filesystem::path& path) {
  const std::string extension = lowercase(path.extension().string());
  if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
  if (extension == ".png") return "image/png";
  if (extension == ".webp") return "image/webp";
  throw std::runtime_error("unsupported stored dataset image type");
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
    {
      std::lock_guard lock(state->system_state_mutex);
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
          care, resolved_camera,
          previous ? previous->detection_state : "disconnected",
          previous ? previous->event_state : "ready",
          reason, utc_now(),
      });
    }
    broadcast_snapshot(state);
  } catch (const std::exception& error) {
    std::cerr << "SQLite runtime state error: " << error.what() << '\n';
  }
}

void save_inference_state(const std::shared_ptr<StreamState>& state) noexcept {
  try {
    if (!state->inference) return;
    const auto inference_snapshot = state->inference->snapshot();
    bool state_changed = false;
    {
      std::lock_guard lock(state->system_state_mutex);
      const auto previous = state->database->load_system_state();
      const auto care = state->events ? state->events->current_care_status()
                                      : std::optional<std::string>{};
      const std::string event_reason = state->events
          ? state->events->current_reason()
          : "Event runtime is starting";
      const std::string detection_state = inference_snapshot.operational ? "running" : "fault";
      const std::string reason = inference_snapshot.operational
          ? event_reason : inference_snapshot.fault_reason;
      if (!previous || previous->care_state != care ||
          previous->detection_state != detection_state || previous->reason != reason) {
        state->database->save_system_state({
            care,
            previous ? previous->camera_state
                     : (state->camera_connected ? "connected" : "idle"),
            detection_state,
            previous ? previous->event_state : "ready",
            reason,
            utc_now(),
        });
        state_changed = true;
      }
    }
    if (state_changed) broadcast_snapshot(state);
    broadcast_inference(state);
  } catch (const std::exception& error) {
    std::cerr << "Inference state error: " << error.what() << '\n';
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
  const auto transition = state->events->apply(observation);
  if (!transition.created && !transition.released &&
      transition.event.event_id.empty()) {
    throw std::invalid_argument("event observation did not change runtime state");
  }
  return event_json(transition.event);
}

void apply_camera_fault(const std::shared_ptr<StreamState>& state, bool active,
                        const std::string& reason) noexcept {
  try {
    rules::EventObservation observation;
    observation.event_type = "camera_fault";
    observation.active = active;
    observation.observed_at = utc_now();
    observation.subject_location = "unknown";
    observation.reason = reason;
    observation.source_results_json =
        R"([{"source":"camera_runtime","note":"V4L2 frame input state"}])";
    state->events->apply(observation);
  } catch (const std::exception& error) {
    std::cerr << "Camera fault event error: " << error.what() << '\n';
  }
}

void apply_detection_fault(const std::shared_ptr<StreamState>& state, bool active,
                           const std::string& reason) noexcept {
  try {
    rules::EventObservation observation;
    observation.event_type = "detection_fault";
    observation.active = active;
    observation.observed_at = utc_now();
    observation.subject_location = "unknown";
    observation.reason = reason;
    observation.source_results_json =
        R"([{"source":"edge_ai_pipeline","runtime":"TensorRT+UnixSocket"}])";
    state->events->apply(observation);
  } catch (const std::exception& error) {
    std::cerr << "Detection fault event error: " << error.what() << '\n';
  }
}

#if defined(WARDY_WITH_TENSORRT)
void apply_fall_observation(const std::shared_ptr<StreamState>& state,
                            std::int64_t track_id, bool active,
                            const std::optional<double>& confidence,
                            const std::string& reason,
                            const std::optional<std::string>& subject_id = std::nullopt,
                            const std::optional<std::string>& subject_name = std::nullopt) {
  rules::EventObservation observation;
  observation.event_type = "fall_suspected";
  observation.active = active;
  observation.observed_at = utc_now();
  observation.subject_id = subject_id.value_or("track-" + std::to_string(track_id));
  observation.subject_name = subject_name;
  observation.subject_location = "unknown";
  observation.reason = reason;
  observation.source_results_json =
      "[{\"source\":\"m02_m04_pose_sequence\",\"track_id\":" +
      std::to_string(track_id) +
      (confidence ? ",\"confidence\":" + json_number(*confidence) : "") + "}]";
  try {
    state->events->apply(observation);
  } catch (const std::invalid_argument&) {
    // A user may confirm or dismiss the event before the model clears it.
    // Releasing an already-terminal event is therefore an expected no-op.
    if (active) throw;
  }
}

void apply_tracking_results(
    const std::shared_ptr<StreamState>& state,
    const inference::TrackingPoseFallResponse& response,
    int frame_width, int frame_height, const std::string& frame_id) {
  if (!response.ok) {
    throw std::runtime_error(response.error.empty()
        ? "M-02/M-03/M-04/M-05 worker rejected the frame" : response.error);
  }
  const std::set<std::int64_t> retained(
      response.active_track_ids.begin(), response.active_track_ids.end());
  {
    std::lock_guard lock(state->active_fall_tracks_mutex);
    for (auto iterator = state->active_fall_tracks.begin();
         iterator != state->active_fall_tracks.end();) {
      if (retained.count(*iterator) == 0) {
        state->active_fall_identities.erase(*iterator);
        iterator = state->active_fall_tracks.erase(iterator);
      } else {
        ++iterator;
      }
    }
  }
  // A fall is an incident, not a frame-level status. Losing the track must not
  // clear an alert before a caregiver has reviewed it. The runtime event stays
  // active until the user explicitly releases or dismisses it.

  for (const auto& person : response.persons) {
    if (!person.fall_suspected) continue;
    bool apply = false;
    std::optional<std::string> event_subject_id = person.subject_id;
    std::optional<std::string> event_subject_name = person.subject_name;
    {
      std::lock_guard lock(state->active_fall_tracks_mutex);
      if (*person.fall_suspected) {
        apply = state->active_fall_tracks.insert(person.track_id).second;
        if (apply) {
          state->active_fall_identities[person.track_id] = {
              person.subject_id, person.subject_name};
        }
      } else {
        apply = state->active_fall_tracks.erase(person.track_id) != 0;
        const auto identity = state->active_fall_identities.find(person.track_id);
        if (identity != state->active_fall_identities.end()) {
          event_subject_id = identity->second.first;
          event_subject_name = identity->second.second;
          state->active_fall_identities.erase(identity);
        }
      }
    }
    if (apply && *person.fall_suspected) {
      apply_fall_observation(
          state, person.track_id, true,
          person.fall_confidence,
          "M-04 temporal pose sequence exceeded the fall threshold",
          event_subject_id, event_subject_name);
    }
  }

  if (!state->inference || frame_width <= 0 || frame_height <= 0) return;
  inference::InferenceFrame output;
  output.frame_id = frame_id;
  output.observed_at = utc_now();
  output.source = "model";
  {
    std::lock_guard lock(state->model_people_mutex);
    for (auto iterator = state->model_people.begin();
         iterator != state->model_people.end();) {
      if (retained.count(iterator->first) == 0) {
        iterator = state->model_people.erase(iterator);
      } else {
        ++iterator;
      }
    }
    for (const auto& person : response.persons) {
      const auto& box = person.bbox_xyxy;
      const auto normalized_box = inference::normalized_response_box(
          box, frame_width, frame_height);
      if (!normalized_box) continue;
      inference::PersonOutput rendered;
      rendered.detection.id = "track-" + std::to_string(person.track_id);
      rendered.detection.box = *normalized_box;
      rendered.detection.class_name = "사람";
      rendered.detection.role = person.subject_role.value_or("");
      rendered.detection.name = person.subject_name.value_or("");
      rendered.detection.subject_id = person.subject_id;
      const auto posture_label = [&person] {
        if (!person.posture) return std::string{"추적 중"};
        if (*person.posture == "standing") return std::string{"서 있음"};
        if (*person.posture == "sitting") return std::string{"앉아 있음"};
        if (*person.posture == "lying") return std::string{"누워 있음"};
        return std::string{"자세 확인 불가"};
      }();
      rendered.detection.posture = person.fall_suspected.value_or(false)
          ? "낙상 의심" : posture_label;
      rendered.detection.confidence = person.detection_confidence;
      rendered.detection.color = person.fall_suspected.value_or(false)
          ? "#d85d52" : "#62b88f";
      inference::FallDiagnostics diagnostics;
      diagnostics.track_id = person.track_id;
      diagnostics.detector_confidence = person.detection_confidence;
      diagnostics.pose_quality = person.pose_quality;
      diagnostics.history_frames = person.history_frames;
      diagnostics.window_frames = person.window_frames;
      diagnostics.fall_confidence = person.fall_confidence;
      diagnostics.fall_threshold = person.fall_threshold;
      diagnostics.keypoints.reserve(person.keypoints_xyc.size());
      for (const auto& keypoint : person.keypoints_xyc) {
        diagnostics.keypoints.push_back({
            std::clamp(keypoint[0] / frame_width, 0.0, 1.0),
            std::clamp(keypoint[1] / frame_height, 0.0, 1.0),
            keypoint[2],
        });
      }
      rendered.detection.fall_diagnostics = std::move(diagnostics);
      // Fall events remain owned by the M-02 track lifecycle above so a
      // one-frame detector miss does not release an active alert.
      rendered.fall_suspected = false;
      state->model_people[person.track_id] = std::move(rendered);
    }
    for (const auto& [track_id, person] : state->model_people) {
      (void)track_id;
      output.people.push_back(person);
    }
  }

  const auto managed_items = state->database->list_managed_items();
  const auto localized_hazard = [](const std::string& name) {
    if (name == "scissors") return std::string{"가위"};
    if (name == "knife") return std::string{"칼"};
    if (name == "cutter") return std::string{"커터칼"};
    if (name == "syringe") return std::string{"주사기"};
    return name;
  };
  for (const auto& hazard : response.hazards) {
    const auto& box = hazard.bbox_xyxy;
    const auto normalized_box = inference::normalized_response_box(
        box, frame_width, frame_height);
    if (!normalized_box) continue;
    inference::HazardOutput rendered;
    rendered.detection.id = hazard.detection_id;
    rendered.detection.box = *normalized_box;
    rendered.detection.class_name = localized_hazard(hazard.class_name);
    rendered.detection.role = "관리 위험물";
    rendered.detection.confidence = hazard.confidence;
    rendered.detection.color = "#d28b2d";
    rendered.included = std::none_of(
        managed_items.begin(), managed_items.end(), [&](const auto& item) {
          return item.policy == "excluded" &&
              (item.label == hazard.class_name ||
               item.label == rendered.detection.class_name);
        });
    const double hazard_x = rendered.detection.box[0] + rendered.detection.box[2] / 2.0;
    const double hazard_y = rendered.detection.box[1] + rendered.detection.box[3] / 2.0;
    rendered.near_person = std::any_of(
        output.people.begin(), output.people.end(), [&](const auto& person) {
          const auto& person_box = person.detection.box;
          const double person_x = person_box[0] + person_box[2] / 2.0;
          const double person_y = person_box[1] + person_box[3] / 2.0;
          return std::hypot(hazard_x - person_x, hazard_y - person_y) <= 0.25;
        });
    if (rendered.near_person) rendered.detection.color = "#d85d52";
    output.hazards.push_back(std::move(rendered));
  }
  state->inference->apply(output);
}

void clear_all_fall_tracks(const std::shared_ptr<StreamState>& state) {
  {
    std::lock_guard lock(state->active_fall_tracks_mutex);
    state->active_fall_tracks.clear();
    state->active_fall_identities.clear();
  }
}
#endif

void apply_inference_fault(const std::shared_ptr<StreamState>& state,
                           const std::string& reason) noexcept {
  try {
    if (!state->inference) return;
    inference::InferenceFrame fault;
    fault.frame_id = "camera-fault-" +
        std::to_string(state->inference_counter.fetch_add(1) + 1);
    fault.observed_at = utc_now();
    fault.source = state->temporary_inference ? "temporary" : "model";
    fault.operational = false;
    fault.fault_reason = reason;
    state->inference->apply(fault);
  } catch (const std::exception& error) {
    std::cerr << "Inference fault error: " << error.what() << '\n';
  }
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

std::string create_zone(const std::string& request,
                        const std::shared_ptr<StreamState>& state) {
  const std::string zone_id = request_header(request, "x-wardy-zone-id").value_or("");
  const std::string name = percent_decode(
      request_header(request, "x-wardy-zone-name").value_or(""));
  if (!safe_item_id(zone_id) || name.empty() || name.size() > 120) {
    throw std::invalid_argument("invalid zone metadata");
  }
  const double x = normalized_coordinate(
      request_header(request, "x-wardy-zone-x").value_or(""));
  const double y = normalized_coordinate(
      request_header(request, "x-wardy-zone-y").value_or(""));
  const double width = normalized_coordinate(
      request_header(request, "x-wardy-zone-width").value_or(""));
  const double height = normalized_coordinate(
      request_header(request, "x-wardy-zone-height").value_or(""));
  if (width <= 0.0 || height <= 0.0 || x + width > 1.0 || y + height > 1.0) {
    throw std::invalid_argument("zone rectangle must stay inside the camera frame");
  }
  const std::string now = utc_now();
  state->database->upsert_zone({zone_id, name, x, y, width, height, now, now});
  return zones_json(state->database->list_zones());
}

std::string update_notification_setting(
    const std::string& request, const std::shared_ptr<StreamState>& state) {
  const std::string event_type =
      request_header(request, "x-wardy-event-type").value_or("");
  const std::string value = lowercase(
      request_header(request, "x-wardy-notification").value_or(""));
  if (!configurable_event_type(event_type) || (value != "on" && value != "off")) {
    throw std::invalid_argument("invalid notification setting");
  }
  state->database->upsert_notification_setting({event_type, value == "on", utc_now()});
  return notification_settings_json(state->database->list_notification_settings());
}

bool enabled_header(const std::string& request, const std::string& name) {
  const std::string value = lowercase(request_header(request, name).value_or(""));
  if (value == "true" || value == "1" || value == "on") return true;
  if (value == "false" || value == "0" || value == "off") return false;
  throw std::invalid_argument("invalid data collection setting");
}

int retention_header(const std::string& request, const std::string& name,
                     int minimum, int maximum) {
  const std::string value = request_header(request, name).value_or("");
  std::size_t parsed = 0;
  int days = 0;
  try {
    days = std::stoi(value, &parsed);
  } catch (const std::exception&) {
    throw std::invalid_argument("invalid data retention period");
  }
  if (parsed != value.size() || days < minimum || days > maximum) {
    throw std::invalid_argument("invalid data retention period");
  }
  return days;
}

std::string consent_version_header(const std::string& request) {
  const std::string value = request_header(request, "x-wardy-consent-version").value_or("");
  if (value.empty() || value.size() > 64 ||
      std::any_of(value.begin(), value.end(), [](unsigned char character) {
        return !(std::isalnum(character) || character == '-' || character == '_' || character == '.');
      })) {
    throw std::invalid_argument("invalid consent version");
  }
  return value;
}

std::string update_data_collection_settings(
    const std::string& request, const std::shared_ptr<StreamState>& state) {
  const std::string now = utc_now();
  storage::DataCollectionSettingsRecord settings;
  settings.identity_review_enabled =
      enabled_header(request, "x-wardy-identity-review-enabled");
  settings.event_media_enabled = enabled_header(request, "x-wardy-event-media-enabled");
  settings.model_improvement_enabled =
      enabled_header(request, "x-wardy-model-improvement-enabled");
  settings.event_media_retention_days =
      retention_header(request, "x-wardy-event-media-retention-days", 1, 365);
  settings.training_data_retention_days =
      retention_header(request, "x-wardy-training-data-retention-days", 1, 3650);
  settings.consent_version = consent_version_header(request);
  settings.consented_at = now;
  settings.updated_at = now;
  state->database->save_data_collection_settings(settings);
  return data_collection_settings_json(settings);
}

std::string update_identity_review(
    const std::string& request, const std::string& review_id,
    const std::shared_ptr<StreamState>& state) {
  const std::string decision =
      request_header(request, "x-wardy-review-decision").value_or("");
  const auto subject_id = decoded_optional_header(request, "x-wardy-subject-id");
  if (decision != "subject" && decision != "unknown" && decision != "excluded") {
    throw std::invalid_argument("invalid identity review decision");
  }
  if (decision == "subject") {
    if (!subject_id || !safe_item_id(*subject_id)) {
      throw std::invalid_argument("subject decision requires a valid subject ID");
    }
    const auto subjects = state->database->list_subjects();
    if (std::none_of(subjects.begin(), subjects.end(), [&](const auto& subject) {
          return subject.subject_id == *subject_id;
        })) {
      throw std::invalid_argument("identity review subject does not exist");
    }
  } else if (subject_id) {
    throw std::invalid_argument("only a subject decision can include a subject ID");
  }
  if (!state->database->update_identity_review_decision(
          review_id, decision, decision == "subject" ? subject_id : std::nullopt,
          utc_now())) {
    throw std::out_of_range("identity review not found");
  }
  return identity_reviews_json(state->database->list_identity_reviews());
}

std::string capture_training_sample(const std::string& request,
                                    const std::shared_ptr<StreamState>& state) {
  if (!state->database->data_collection_settings().model_improvement_enabled) {
    throw std::invalid_argument("data collection consent is required");
  }
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
  if (!state->database->data_collection_settings().identity_review_enabled) {
    throw std::invalid_argument("identity data collection consent is required");
  }
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

struct DatasetSampleMetadata {
  std::string model_id;
  std::string requirement_id;
  std::string label;
  std::string capture_session;
};

DatasetSampleMetadata dataset_sample_metadata(const std::string& request) {
  DatasetSampleMetadata metadata{
      request_header(request, "x-wardy-model-id").value_or(""),
      request_header(request, "x-wardy-requirement-id").value_or(""),
      percent_decode(request_header(request, "x-wardy-label").value_or("")),
      percent_decode(request_header(request, "x-wardy-capture-session").value_or("")),
  };
  if (!safe_item_id(metadata.model_id) || !safe_item_id(metadata.requirement_id) ||
      metadata.label.empty() || metadata.label.size() > 120 ||
      metadata.capture_session.empty() || metadata.capture_session.size() > 120) {
    throw std::invalid_argument("invalid dataset sample metadata");
  }
  return metadata;
}

std::string store_dataset_sample(
    const DatasetSampleMetadata& metadata, const std::string& source,
    const std::optional<std::string>& original_filename, const std::string& extension,
    const std::vector<unsigned char>& bytes, int width, int height,
    const std::shared_ptr<StreamState>& state) {
  const std::string captured_at = utc_now();
  const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string sample_id = "dataset-sample-" + std::to_string(timestamp) + "-" +
                                std::to_string(++state->sample_counter);
  const std::filesystem::path relative_path = std::filesystem::path("datasets") /
      metadata.model_id / metadata.requirement_id / (sample_id + extension);
  const std::filesystem::path absolute_path = state->training_data_path / relative_path;
  std::filesystem::create_directories(absolute_path.parent_path());
  {
    std::ofstream output(absolute_path, std::ios::binary);
    if (!output) throw std::runtime_error("failed to create dataset sample file");
    output.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
    if (!output) throw std::runtime_error("failed to write dataset sample file");
  }
  try {
    state->database->add_dataset_sample({
        sample_id, metadata.model_id, metadata.requirement_id, metadata.label,
        "pending", metadata.capture_session, source, relative_path.generic_string(),
        original_filename, captured_at, width, height,
    });
    return dataset_samples_json(state->database->list_dataset_samples());
  } catch (...) {
    std::error_code remove_error;
    std::filesystem::remove(absolute_path, remove_error);
    throw;
  }
}

std::string capture_dataset_sample(const std::string& request,
                                   const std::shared_ptr<StreamState>& state) {
  if (!state->database->data_collection_settings().model_improvement_enabled) {
    throw std::invalid_argument("data collection consent is required");
  }
  const auto metadata = dataset_sample_metadata(request);
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
      throw std::runtime_error("camera dataset sample capture timed out");
    }
    jpeg = state->jpeg;
  }
  return store_dataset_sample(metadata, "jetson_camera", std::nullopt, ".jpg", jpeg,
                              state->frame_width, state->frame_height, state);
}

std::string upload_dataset_sample(const std::string& request,
                                  const std::shared_ptr<StreamState>& state) {
  if (!state->database->data_collection_settings().model_improvement_enabled) {
    throw std::invalid_argument("data collection consent is required");
  }
  const auto metadata = dataset_sample_metadata(request);
  const std::string content_type = lowercase(
      request_header(request, "content-type").value_or(""));
  const std::string extension = content_type == "image/jpeg" ? ".jpg" :
      content_type == "image/png" ? ".png" :
      content_type == "image/webp" ? ".webp" : "";
  if (extension.empty()) throw std::invalid_argument("unsupported dataset image type");
  const std::string body = request_body(request);
  const std::vector<unsigned char> bytes(body.begin(), body.end());
  const cv::Mat decoded = cv::imdecode(bytes, cv::IMREAD_COLOR);
  if (decoded.empty()) throw std::invalid_argument("invalid dataset image file");
  const std::string filename = percent_decode(
      request_header(request, "x-wardy-original-filename").value_or(""));
  if (filename.empty() || filename.size() > 255) {
    throw std::invalid_argument("invalid original filename");
  }
  return store_dataset_sample(metadata, "local_file", filename, extension, bytes,
                              decoded.cols, decoded.rows, state);
}

std::string update_dataset_sample(const std::string& request,
                                  const std::string& sample_id,
                                  const std::shared_ptr<StreamState>& state) {
  const std::string label = percent_decode(
      request_header(request, "x-wardy-label").value_or(""));
  const std::string review_status =
      request_header(request, "x-wardy-review-status").value_or("");
  if (label.empty() || label.size() > 120 ||
      (review_status != "pending" && review_status != "approved" &&
       review_status != "rejected")) {
    throw std::invalid_argument("invalid dataset sample review");
  }
  if (!state->database->update_dataset_sample(sample_id, label, review_status)) {
    throw std::out_of_range("dataset sample not found");
  }
  return dataset_samples_json(state->database->list_dataset_samples());
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

void serve_websocket(int socket_fd, const std::string& request,
                     const std::shared_ptr<StreamState>& state,
                     const MjpegServiceConfig& config) {
  const auto key = request_header(request, "sec-websocket-key");
  if (!key || lowercase(request_header(request, "upgrade").value_or("")) != "websocket" ||
      !origin_allowed(request, config.allowed_origin) ||
      !websocket_authorized(request, config.access_token)) {
    send_text(socket_fd, json_response(403, "Forbidden", "{\"error\":\"WebSocket access denied\"}",
                                       config.allowed_origin));
    return;
  }
  constexpr std::size_t max_websocket_clients = 8;
  bool client_limit_reached = false;
  {
    std::lock_guard lock(state->websocket_mutex);
    if (state->websocket_clients.size() + state->websocket_reservations >=
        max_websocket_clients) {
      client_limit_reached = true;
    } else {
      ++state->websocket_reservations;
    }
  }
  if (client_limit_reached) {
    send_text(socket_fd, json_response(503, "Service Unavailable",
        "{\"error\":\"WebSocket client limit reached\"}", config.allowed_origin));
    return;
  }
  const std::string handshake =
      "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Accept: " + websocket_accept_key(*key) + "\r\n"
      "Sec-WebSocket-Protocol: wardy-events\r\n\r\n";
  if (!send_text(socket_fd, handshake)) {
    std::lock_guard lock(state->websocket_mutex);
    --state->websocket_reservations;
    return;
  }
  {
    std::lock_guard lock(state->websocket_mutex);
    --state->websocket_reservations;
    state->websocket_clients.push_back(socket_fd);
  }
  if (const auto snapshot = runtime_snapshot(state)) {
    const std::string frame = websocket_text_frame(*snapshot);
    std::lock_guard send_lock(state->websocket_send_mutex);
    if (!send_all(socket_fd, frame.data(), frame.size())) {
      remove_websocket_client(state, socket_fd);
      return;
    }
  }
  if (state->inference) {
    const std::string frame = websocket_text_frame(
        inference::inference_message_json(state->inference->snapshot()));
    std::lock_guard send_lock(state->websocket_send_mutex);
    if (!send_all(socket_fd, frame.data(), frame.size())) {
      remove_websocket_client(state, socket_fd);
      return;
    }
  }

  unsigned char input[256];
  while (state->running) {
    const auto count = ::recv(socket_fd, input, sizeof(input), 0);
    if (count == 0) break;
    if (count < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
      break;
    }
    if ((input[0] & 0x0fU) == 0x08U) break;
  }
  remove_websocket_client(state, socket_fd);
}

void handle_client(int socket_fd, const std::shared_ptr<StreamState>& state,
                   const MjpegServiceConfig config) {
  if (!apply_socket_timeouts(socket_fd)) {
    ::close(socket_fd);
    return;
  }
  const std::string request = read_request(socket_fd);
  const auto [method, path] = request_method_path(request);
  const auto media_event_id = event_media_path(path);
  const auto dataset_sample_media_id = dataset_sample_media_path(path);
  const auto identity_review_media_id = identity_review_media_path(path);
  const auto event_action = event_action_path(path);
  const auto subject_id_path = resource_id_path(path, "/api/subjects/");
  const auto managed_item_id_path = resource_id_path(path, "/api/managed-items/");
  const auto zone_id_path = resource_id_path(path, "/api/zones/");
  const auto dataset_sample_id_path = resource_id_path(path, "/api/data-samples/");
  const auto identity_review_id_path = resource_id_path(path, "/api/identity-reviews/");
  try {
  const bool protected_api = protected_api_path(path);
  if (method == "OPTIONS") {
    if (origin_allowed(request, config.allowed_origin)) {
      send_text(socket_fd, options_response(config.allowed_origin));
    } else {
      send_text(socket_fd, json_response(403, "Forbidden", "{\"error\":\"Origin denied\"}",
                                         config.allowed_origin));
    }
  } else if (protected_api &&
             (!origin_allowed(request, config.allowed_origin) ||
              !access_token_authorized(request, config.access_token))) {
    send_text(socket_fd, json_response(403, "Forbidden", "{\"error\":\"Access denied\"}",
                                       config.allowed_origin));
  } else if (method == "GET" && path == "/api/health") {
    send_text(socket_fd, health_response(state->camera_connected, config.allowed_origin));
  } else if (method == "GET" && path == "/api/ws") {
    serve_websocket(socket_fd, request, state, config);
  } else if (method == "GET" && path == "/api/camera/stream") {
    serve_stream(socket_fd, state, config.allowed_origin);
  } else if (method == "GET" && path == "/api/events") {
    send_text(socket_fd, json_response(200, "OK",
        events_json(api_events(state)), config.allowed_origin));
  } else if (method == "GET" && path == "/api/inference") {
    if (!state->inference) {
      send_text(socket_fd, json_response(200, "OK",
          inference::inference_json({}), config.allowed_origin));
    } else {
      send_text(socket_fd, json_response(200, "OK",
          inference::inference_json(state->inference->snapshot()), config.allowed_origin));
    }
  } else if (method == "POST" && path == "/api/llm/daily-summary") {
    const std::string date = request_header(request, "X-Wardy-Summary-Date")
        .value_or(kst_date_now());
    if (!valid_summary_date(date)) {
      send_text(socket_fd, json_response(400, "Bad Request",
          "{\"error\":\"Summary date must use YYYY-MM-DD\"}", config.allowed_origin));
    } else {
      const auto daily_events = state->database->list_events_for_kst_date(date);
      std::unique_lock lock(state->daily_summary_mutex, std::try_to_lock);
      if (!lock.owns_lock()) {
        send_text(socket_fd, json_response(429, "Too Many Requests",
            "{\"error\":\"Daily summary generation is already running\"}",
            config.allowed_origin));
      } else {
        const auto summary = state->daily_summary->summarize(date, daily_events);
        send_text(socket_fd, json_response(200, "OK", daily_summary_json(summary),
                                           config.allowed_origin));
      }
    }
  } else if (method == "GET" && path == "/api/state") {
    const auto current = state->database->load_system_state();
    if (!current) {
      send_text(socket_fd, json_response(404, "Not Found",
          "{\"error\":\"State not initialized\"}", config.allowed_origin));
    } else {
      send_text(socket_fd, json_response(200, "OK", state_json(*current),
                                         config.allowed_origin));
    }
  } else if (method == "GET" && media_event_id) {
    const auto event = state->database->get_event(*media_event_id);
    if (!event || !event->media_path) {
      send_text(socket_fd, json_response(404, "Not Found", "{\"error\":\"Event media not found\"}",
                                         config.allowed_origin));
    } else {
      const auto file = stored_media_file(state, *event);
      std::ifstream input(file, std::ios::binary);
      if (!input) throw std::runtime_error("event media file is missing");
      const std::vector<unsigned char> bytes(
          (std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
      send_binary_response(socket_fd, bytes,
          event->media_type == "image" ? "image/jpeg" : "video/mp4", config.allowed_origin);
    }
  } else if (method == "DELETE" && media_event_id) {
    const auto event = state->database->get_event(*media_event_id);
    if (!event) {
      send_text(socket_fd, json_response(404, "Not Found", "{\"error\":\"Event not found\"}",
                                         config.allowed_origin));
    } else {
      const auto stored_path = event->media_path;
      if (stored_path) {
        const auto file = stored_media_file(state, *event);
        std::error_code error;
        std::filesystem::remove(file, error);
        if (error) throw std::runtime_error("failed to delete event media file");
      }
      (void)state->database->clear_event_media(event->event_id);
      broadcast_snapshot(state);
      send_text(socket_fd, json_response(200, "OK", "{\"deleted\":true}",
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
  } else if (method == "POST" && event_action) {
    const auto& [event_id, action] = *event_action;
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
  } else if (method == "DELETE" && subject_id_path) {
    const std::string& subject_id = *subject_id_path;
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
  } else if (method == "DELETE" && managed_item_id_path) {
    const std::string& item_id = *managed_item_id_path;
    const bool deleted = state->database->delete_managed_item(item_id);
    if (deleted) {
      std::error_code error;
      std::filesystem::remove_all(state->training_data_path / "items" / item_id, error);
    }
    send_text(socket_fd, json_response(deleted ? 200 : 404, deleted ? "OK" : "Not Found",
        managed_items_json(state->database->list_managed_items()), config.allowed_origin));
  } else if (method == "GET" && path == "/api/zones") {
    send_text(socket_fd, json_response(200, "OK",
        zones_json(state->database->list_zones()), config.allowed_origin));
  } else if (method == "POST" && path == "/api/zones") {
    send_text(socket_fd, json_response(201, "Created", create_zone(request, state),
                                       config.allowed_origin));
  } else if (method == "DELETE" && zone_id_path) {
    const bool deleted = state->database->delete_zone(*zone_id_path);
    send_text(socket_fd, json_response(deleted ? 200 : 404, deleted ? "OK" : "Not Found",
        zones_json(state->database->list_zones()), config.allowed_origin));
  } else if (method == "GET" && path == "/api/notification-settings") {
    send_text(socket_fd, json_response(200, "OK",
        notification_settings_json(state->database->list_notification_settings()),
        config.allowed_origin));
  } else if (method == "POST" && path == "/api/notification-settings") {
    send_text(socket_fd, json_response(200, "OK",
        update_notification_setting(request, state), config.allowed_origin));
  } else if (method == "GET" && path == "/api/data-collection-settings") {
    send_text(socket_fd, json_response(200, "OK",
        data_collection_settings_json(state->database->data_collection_settings()),
        config.allowed_origin));
  } else if (method == "POST" && path == "/api/data-collection-settings") {
    try {
      send_text(socket_fd, json_response(200, "OK",
          update_data_collection_settings(request, state), config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
  } else if (method == "GET" && path == "/api/identity-reviews") {
    send_text(socket_fd, json_response(200, "OK",
        identity_reviews_json(state->database->list_identity_reviews()),
        config.allowed_origin));
  } else if (method == "GET" && identity_review_media_id) {
    const auto review = state->database->get_identity_review(*identity_review_media_id);
    if (!review) {
      send_text(socket_fd, json_response(404, "Not Found",
          "{\"error\":\"Identity review not found\"}", config.allowed_origin));
    } else {
      const auto image_file = stored_identity_review_file(state, *review);
      std::ifstream input(image_file, std::ios::binary);
      if (!input) {
        send_text(socket_fd, json_response(404, "Not Found",
            "{\"error\":\"Identity review image not found\"}", config.allowed_origin));
      } else {
        const std::vector<unsigned char> image{
            std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
        send_binary_response(socket_fd, image, dataset_image_content_type(image_file),
                             config.allowed_origin);
      }
    }
  } else if (method == "POST" && identity_review_id_path) {
    try {
      send_text(socket_fd, json_response(200, "OK",
          update_identity_review(request, *identity_review_id_path, state),
          config.allowed_origin));
    } catch (const std::out_of_range& error) {
      send_text(socket_fd, json_response(404, "Not Found",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
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
  } else if (method == "GET" && path == "/api/data-samples") {
    send_text(socket_fd, json_response(200, "OK",
        dataset_samples_json(state->database->list_dataset_samples()),
        config.allowed_origin));
  } else if (method == "GET" && dataset_sample_media_id) {
    const auto sample = state->database->get_dataset_sample(*dataset_sample_media_id);
    if (!sample) {
      send_text(socket_fd, json_response(404, "Not Found",
          "{\"error\":\"Dataset sample not found\"}", config.allowed_origin));
    } else {
      const std::filesystem::path image_file = stored_dataset_file(state, *sample);
      std::ifstream input(image_file, std::ios::binary);
      if (!input) {
        send_text(socket_fd, json_response(404, "Not Found",
            "{\"error\":\"Dataset sample image not found\"}", config.allowed_origin));
      } else {
        const std::vector<unsigned char> image{
            std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
        send_binary_response(socket_fd, image, dataset_image_content_type(image_file),
                             config.allowed_origin);
      }
    }
  } else if (method == "POST" && path == "/api/data-samples/camera") {
    try {
      send_text(socket_fd, json_response(201, "Created",
          capture_dataset_sample(request, state), config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    } catch (const std::exception& error) {
      send_text(socket_fd, json_response(503, "Service Unavailable",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
  } else if (method == "POST" && path == "/api/data-samples/upload") {
    try {
      send_text(socket_fd, json_response(201, "Created",
          upload_dataset_sample(request, state), config.allowed_origin));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
  } else if (method == "POST" && dataset_sample_id_path) {
    try {
      send_text(socket_fd, json_response(200, "OK",
          update_dataset_sample(request, *dataset_sample_id_path, state),
          config.allowed_origin));
    } catch (const std::out_of_range& error) {
      send_text(socket_fd, json_response(404, "Not Found",
          "{\"error\":\"" + json_escape(error.what()) + "\"}", config.allowed_origin));
    }
  } else if (method == "DELETE" && dataset_sample_id_path) {
    const auto sample = state->database->get_dataset_sample(*dataset_sample_id_path);
    if (!sample) {
      send_text(socket_fd, json_response(404, "Not Found",
          "{\"error\":\"Dataset sample not found\"}", config.allowed_origin));
    } else {
      std::error_code error;
      std::filesystem::remove(stored_dataset_file(state, *sample), error);
      if (error) throw std::runtime_error("failed to delete dataset sample file");
      if (!state->database->delete_dataset_sample(*dataset_sample_id_path)) {
        throw std::runtime_error("failed to delete dataset sample record");
      }
      send_text(socket_fd, json_response(200, "OK",
          dataset_samples_json(state->database->list_dataset_samples()),
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
  bool camera_fault_active = state->events->has_active_event_type("camera_fault");
  while (state->running) {
    try {
      input::CameraCapture camera(config.camera);
      camera.open();
      cv::Mat frame;
      const std::vector<int> encode_parameters{cv::IMWRITE_JPEG_QUALITY,
                                                config.jpeg_quality};
      auto next_preview_at = std::chrono::steady_clock::now();
      auto next_inference_at = std::chrono::steady_clock::now();
      bool connected_reported = false;
      while (state->running) {
        if (!camera.read(frame)) {
          throw std::runtime_error("failed to read a frame from the Jetson camera");
        }
        if (state->event_media) state->event_media->push_frame(frame);
#if defined(WARDY_WITH_TENSORRT)
        if (state->person_inference) {
          const auto timestamp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::system_clock::now().time_since_epoch()).count();
          const auto sequence = state->inference_counter.fetch_add(1) + 1;
          state->person_inference->submit(
              frame, "camera-" + std::to_string(sequence), timestamp_ms,
              !connected_reported);
        }
#endif
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
          if (camera_fault_active) {
            apply_camera_fault(state, false, "Jetson camera frame input recovered");
            camera_fault_active = false;
          }
        }
        state->frame_width = frame.cols;
        state->frame_height = frame.rows;
        const auto now = std::chrono::steady_clock::now();
        if (state->temporary_inference && now >= next_inference_at) {
          const auto temporary_frame = state->temporary_inference->infer(
              "temporary-" +
                  std::to_string(state->inference_counter.fetch_add(1) + 1),
              utc_now());
          if (temporary_frame.operational &&
              state->detection_fault_active.exchange(false)) {
            apply_detection_fault(
                state, false, "Temporary inference output recovered");
          }
          state->inference->apply(temporary_frame);
          next_inference_at = now + std::chrono::milliseconds(100);
        }
        const int served_requests = state->sample_capture_requests.load();
        if (state->stream_clients == 0 && served_requests == 0) continue;

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
        apply_inference_fault(
            state, "카메라 입력이 없어 안전 감지를 실행할 수 없습니다.");
        std::cerr << "Jetson camera error: " << error.what() << '\n';
      }
      if (!camera_fault_active) {
        apply_camera_fault(state, true, error.what());
        camera_fault_active = true;
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
  if (event_media_path.empty()) throw std::invalid_argument("event media path must not be empty");
  if (allowed_origin.empty()) throw std::invalid_argument("allowed UI origin must not be empty");
  if (allowed_origin.find_first_of("\r\n") != std::string::npos ||
      (allowed_origin.rfind("http://", 0) != 0 && allowed_origin.rfind("https://", 0) != 0)) {
    throw std::invalid_argument("allowed UI origin must be an HTTP(S) origin");
  }
  if (access_token.empty()) throw std::invalid_argument("WARDY_ACCESS_TOKEN must not be empty");
  if (!std::isfinite(person_confidence_threshold) ||
      person_confidence_threshold < 0.0F || person_confidence_threshold > 1.0F ||
      !std::isfinite(person_nms_iou_threshold) ||
      person_nms_iou_threshold < 0.0F || person_nms_iou_threshold > 1.0F) {
    throw std::invalid_argument("person detection thresholds must be inside [0,1]");
  }
  if (person_class_index < 0) {
    throw std::invalid_argument("person class index must be non-negative");
  }
  if (!person_detector_engine_path.empty() && pose_fall_socket_path.empty()) {
    throw std::invalid_argument("pose/fall socket path must not be empty when M-01 is enabled");
  }
  if (inference_source != "auto" && inference_source != "disabled" &&
      inference_source != "temporary") {
    throw std::invalid_argument("WARDY_INFERENCE_SOURCE must be auto, disabled, or temporary");
  }
  if (inference_source == "temporary") {
    (void)inference::TemporaryInferenceProducer(temporary_inference_scenario);
  }
  llm::DailySummaryConfig llm_config;
  llm_config.enabled = llm_enabled;
  llm_config.model = llm_model;
  llm_config.timeout = std::chrono::seconds{llm_timeout_seconds};
  llm_config.validate();
}

MjpegService::MjpegService(MjpegServiceConfig config) : config_(std::move(config)) {
  config_.validate();
}

int MjpegService::run(const std::atomic_bool& stop_requested) {
  const auto state = std::make_shared<StreamState>();
  state->database = std::make_shared<storage::SqliteStore>(config_.database_path);
  state->database->initialize();
  llm::DailySummaryConfig llm_config;
  llm_config.enabled = config_.llm_enabled;
  llm_config.model = config_.llm_model;
  llm_config.timeout = std::chrono::seconds{config_.llm_timeout_seconds};
  state->daily_summary = std::make_shared<llm::DailySummaryService>(llm_config);
  state->training_data_path = config_.training_data_path;
  const std::weak_ptr<StreamState> weak_state = state;
  state->event_media = std::make_shared<media::EventMediaRecorder>(
      config_.event_media_path, *state->database, [weak_state] {
        if (const auto locked = weak_state.lock()) broadcast_snapshot(locked);
      });
  state->events = std::make_shared<rules::EventRuntime>(
      *state->database, [weak_state](const storage::EventRecord& event) {
        if (const auto locked = weak_state.lock()) {
          save_runtime_state(locked);
          if (event.event_status == "new") schedule_event_media(locked, event);
        }
      });
  state->detection_fault_active =
      state->events->has_active_event_type("detection_fault");
  // EventRuntime restores unresolved incidents before the camera loop starts.
  // Persist that restored aggregate immediately so a stale system_state row
  // cannot disagree with the event card shown to the operator.
  save_runtime_state(state);
#if defined(WARDY_WITH_TENSORRT)
  if (!config_.person_detector_engine_path.empty()) {
    const auto pose_fall_client = std::make_shared<inference::PoseFallClient>(
        config_.pose_fall_socket_path);
    state->person_inference = std::make_shared<inference::PersonInferenceRuntime>(
        inference::PersonDetectorConfig{
            config_.person_detector_engine_path,
            config_.person_confidence_threshold,
            config_.person_nms_iou_threshold,
            static_cast<std::size_t>(config_.person_class_index),
        },
        [weak_state, pose_fall_client](
            const cv::Mat& frame, const std::string& frame_id,
            std::int64_t timestamp_ms,
            const std::vector<inference::PersonDetection>& detections,
            bool reset_tracking) {
          if (const auto locked = weak_state.lock()) {
            if (reset_tracking) {
              clear_all_fall_tracks(locked);
            }
            const auto response = pose_fall_client->infer_frame(
                frame, frame_id, timestamp_ms, detections, reset_tracking);
            apply_tracking_results(
                locked, response, frame.cols, frame.rows, frame_id);
            if (!locked->detection_running_reported.exchange(true)) {
              save_detection_state(locked, "running",
                                   "M-01 through M-05 inference is running");
            }
          }
        },
        [weak_state](bool ready, const std::string& message) {
          if (const auto locked = weak_state.lock()) {
            if (ready) {
              save_detection_state(locked, "ready", message);
              if (locked->detection_fault_active.exchange(false)) {
                apply_detection_fault(locked, false, message);
              }
            } else {
              locked->detection_running_reported = false;
              std::cerr << "Inference pipeline error: " << message << '\n';
              const std::string public_message =
                  "AI 안전 감지를 일시적으로 사용할 수 없습니다.";
              save_detection_state(locked, "fault", public_message);
              if (!locked->detection_fault_active.exchange(true)) {
                apply_detection_fault(locked, true, public_message);
              }
            }
          }
        });
  }
#else
  if (!config_.person_detector_engine_path.empty()) {
    throw std::runtime_error(
        "WARDY_PERSON_ENGINE is set but this binary was built without TensorRT/CUDA");
  }
#endif
  if (config_.inference_source == "temporary" ||
      (config_.inference_source == "auto" &&
       !config_.person_detector_engine_path.empty())) {
    state->inference = std::make_shared<inference::InferenceOutputRuntime>(
        *state->events, [weak_state] {
          if (const auto locked = weak_state.lock()) save_inference_state(locked);
        });
    if (config_.inference_source == "temporary") {
      state->temporary_inference = std::make_shared<inference::TemporaryInferenceProducer>(
          config_.temporary_inference_scenario);
    }
  }
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
#if defined(WARDY_WITH_TENSORRT)
  if (state->person_inference) state->person_inference->stop();
#endif
  state->event_media->stop();
  save_camera_state(state, "idle", "Wardy edge service stopped");
  return 0;
}

}  // namespace wardy::api
