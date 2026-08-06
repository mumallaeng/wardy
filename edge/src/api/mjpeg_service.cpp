#include "api/mjpeg_service.hpp"

#include "api/http_response.hpp"
#include "input/camera_capture.hpp"
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
    state->database->save_system_state({
        std::nullopt, camera_state, "disconnected", "ready", reason, utc_now(),
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
  } catch (...) {
    std::error_code remove_error;
    std::filesystem::remove(absolute_path, remove_error);
    throw;
  }

  const std::size_t sample_count = state->database->count_training_samples(item_id);
  return "{\"sample_id\":\"" + sample_id + "\",\"image_path\":\"" +
         relative_path.generic_string() + "\",\"sample_count\":" +
         std::to_string(sample_count) + "}";
}

void serve_stream(int socket_fd, const std::shared_ptr<StreamState>& state) {
  const StreamClientRegistration registration(state);
  {
    std::unique_lock lock(state->mutex);
    state->frame_ready.wait_for(lock, std::chrono::seconds(3), [&] {
      return !state->running || !state->jpeg.empty() || !state->camera_error.empty();
    });
    if (state->jpeg.empty()) {
      send_text(socket_fd, json_response(503, "Service Unavailable",
                                         "{\"error\":\"Jetson camera is unavailable\"}"));
      return;
    }
  }

  if (!send_text(socket_fd, mjpeg_headers())) return;

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

void handle_client(int socket_fd, const std::shared_ptr<StreamState>& state) {
  const std::string request = read_request(socket_fd);
  if (request.rfind("OPTIONS ", 0) == 0) {
    send_text(socket_fd, options_response());
  } else if (request.rfind("GET /api/health ", 0) == 0) {
    send_text(socket_fd, health_response(state->camera_connected));
  } else if (request.rfind("GET /api/camera/stream ", 0) == 0) {
    serve_stream(socket_fd, state);
  } else if (request.rfind("POST /api/training/items/sample ", 0) == 0) {
    try {
      send_text(socket_fd, json_response(201, "Created",
                                         capture_training_sample(request, state)));
    } catch (const std::invalid_argument& error) {
      send_text(socket_fd, json_response(400, "Bad Request",
                                         "{\"error\":\"" + std::string(error.what()) + "\"}"));
    } catch (const std::exception& error) {
      send_text(socket_fd, json_response(503, "Service Unavailable",
                                         "{\"error\":\"" + std::string(error.what()) + "\"}"));
    }
  } else {
    send_text(socket_fd, json_response(404, "Not Found", "{\"error\":\"Not found\"}"));
  }
  ::close(socket_fd);
}

void capture_frames(const MjpegServiceConfig& config,
                    const std::shared_ptr<StreamState>& state) {
  try {
    input::CameraCapture camera(config.camera);
    camera.open();
    state->camera_connected = true;
    save_camera_state(state, "connected", "Jetson camera frame input is ready");
    cv::Mat frame;
    const std::vector<int> encode_parameters{cv::IMWRITE_JPEG_QUALITY,
                                              config.jpeg_quality};
    auto next_preview_at = std::chrono::steady_clock::now();
    while (state->running) {
      if (!camera.read(frame)) {
        throw std::runtime_error("failed to read a frame from the Jetson camera");
      }
      state->frame_width = frame.cols;
      state->frame_height = frame.rows;
      if (state->stream_clients == 0 && state->sample_capture_requests == 0) continue;

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
      state->sample_capture_requests = 0;
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
    save_camera_state(state, "fault", error.what());
    std::cerr << "Jetson camera error: " << error.what() << '\n';
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
  address.sin_addr.s_addr = htonl(INADDR_ANY);
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
}

MjpegService::MjpegService(MjpegServiceConfig config) : config_(std::move(config)) {
  config_.validate();
}

int MjpegService::run(const std::atomic_bool& stop_requested) {
  const auto state = std::make_shared<StreamState>();
  state->database = std::make_shared<storage::SqliteStore>(config_.database_path);
  state->database->initialize();
  state->training_data_path = config_.training_data_path;
  const int server_fd = open_server_socket(config_.port);
  save_camera_state(state, "connecting", "Jetson camera connection is starting");
  std::thread capture_thread(capture_frames, std::cref(config_), state);
  std::cout << "Wardy edge service listening on 0.0.0.0:" << config_.port << '\n';

  while (!stop_requested) {
    fd_set read_set;
    FD_ZERO(&read_set);
    FD_SET(server_fd, &read_set);
    timeval timeout{0, 250000};
    const int ready = ::select(server_fd + 1, &read_set, nullptr, nullptr, &timeout);
    if (ready <= 0) continue;

    const int client_fd = ::accept(server_fd, nullptr, nullptr);
    if (client_fd >= 0) {
      std::thread(handle_client, client_fd, state).detach();
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
