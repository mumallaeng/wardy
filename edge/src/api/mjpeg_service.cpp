#include "api/mjpeg_service.hpp"

#include "api/http_response.hpp"
#include "input/camera_capture.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <opencv2/core/mat.hpp>
#include <opencv2/imgcodecs.hpp>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace wardy::api {
namespace {

struct StreamState {
  std::atomic_bool running{true};
  std::atomic_bool camera_connected{false};
  std::atomic_int stream_clients{0};
  std::mutex mutex;
  std::condition_variable frame_ready;
  std::vector<unsigned char> jpeg;
  std::size_t sequence = 0;
  std::string camera_error;
};

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
    cv::Mat frame;
    const std::vector<int> encode_parameters{cv::IMWRITE_JPEG_QUALITY,
                                              config.jpeg_quality};
    auto next_preview_at = std::chrono::steady_clock::now();
    while (state->running) {
      if (!camera.read(frame)) {
        throw std::runtime_error("failed to read a frame from the Jetson camera");
      }
      if (state->stream_clients == 0) continue;

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
}

MjpegService::MjpegService(MjpegServiceConfig config) : config_(std::move(config)) {
  config_.validate();
}

int MjpegService::run(const std::atomic_bool& stop_requested) {
  const auto state = std::make_shared<StreamState>();
  const int server_fd = open_server_socket(config_.port);
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
  return 0;
}

}  // namespace wardy::api
