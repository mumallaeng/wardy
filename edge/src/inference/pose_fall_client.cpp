#include "inference/pose_fall_client.hpp"

#include "api/json_serialization.hpp"

#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/core/persistence.hpp>

namespace wardy::inference {
namespace {

constexpr std::size_t kMaximumResponseBytes = 1024U * 1024U;
constexpr long kSocketTimeoutSeconds = 5;

std::string base64(const std::vector<unsigned char>& data) {
  constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(((data.size() + 2U) / 3U) * 4U);
  for (std::size_t index = 0; index < data.size(); index += 3U) {
    const std::uint32_t block = (static_cast<std::uint32_t>(data[index]) << 16U) |
        (index + 1U < data.size()
             ? static_cast<std::uint32_t>(data[index + 1U]) << 8U
             : 0U) |
        (index + 2U < data.size()
             ? static_cast<std::uint32_t>(data[index + 2U])
             : 0U);
    output.push_back(alphabet[(block >> 18U) & 0x3fU]);
    output.push_back(alphabet[(block >> 12U) & 0x3fU]);
    output.push_back(index + 1U < data.size() ? alphabet[(block >> 6U) & 0x3fU] : '=');
    output.push_back(index + 2U < data.size() ? alphabet[block & 0x3fU] : '=');
  }
  return output;
}

void close_socket(int descriptor) {
  if (descriptor >= 0) close(descriptor);
}

void write_all(int descriptor, const std::string& payload) {
  std::size_t offset = 0;
  while (offset < payload.size()) {
    const ssize_t count = send(
        descriptor, payload.data() + offset, payload.size() - offset, MSG_NOSIGNAL);
    if (count < 0) {
      if (errno == EINTR) continue;
      throw std::runtime_error(std::string{"pose/fall socket write failed: "} + std::strerror(errno));
    }
    if (count == 0) throw std::runtime_error("pose/fall socket closed while writing");
    offset += static_cast<std::size_t>(count);
  }
}

std::string read_line(int descriptor) {
  std::string response;
  char buffer[4096];
  while (response.size() <= kMaximumResponseBytes) {
    const ssize_t count = recv(descriptor, buffer, sizeof(buffer), 0);
    if (count < 0) {
      if (errno == EINTR) continue;
      throw std::runtime_error(std::string{"pose/fall socket read failed: "} + std::strerror(errno));
    }
    if (count == 0) break;
    response.append(buffer, static_cast<std::size_t>(count));
    const auto newline = response.find('\n');
    if (newline != std::string::npos) {
      response.resize(newline);
      return response;
    }
  }
  if (response.size() > kMaximumResponseBytes) {
    throw std::runtime_error("pose/fall response exceeds 1 MiB");
  }
  throw std::runtime_error("pose/fall worker closed without a complete response");
}

PoseFallResponse parse_response(std::string response) {
  cv::FileStorage document(response, cv::FileStorage::READ |
      cv::FileStorage::MEMORY | cv::FileStorage::FORMAT_JSON);
  if (!document.isOpened() || document.root().type() != cv::FileNode::MAP) {
    throw std::runtime_error("pose/fall worker returned invalid JSON");
  }
  PoseFallResponse parsed;
  parsed.raw_json = std::move(response);
  const cv::FileNode ok = document["ok"];
  if (ok.empty() || !ok.isInt()) {
    throw std::runtime_error("pose/fall response is missing boolean ok");
  }
  parsed.ok = static_cast<int>(ok) != 0;
  const cv::FileNode accepted = document["accepted"];
  if (!accepted.empty()) parsed.accepted = static_cast<int>(accepted) != 0;
  const cv::FileNode error = document["error"];
  if (!error.empty() && error.isString()) parsed.error = static_cast<std::string>(error);

  const cv::FileNode fall = document["fall"];
  if (!fall.empty() && fall.type() == cv::FileNode::MAP) {
    const cv::FileNode suspected = fall["fall_suspected"];
    const cv::FileNode confidence = fall["confidence"];
    if (suspected.empty() || !suspected.isInt() || confidence.empty() ||
        (!confidence.isInt() && !confidence.isReal())) {
      throw std::runtime_error("pose/fall response contains an invalid fall result");
    }
    parsed.fall_suspected = static_cast<int>(suspected) != 0;
    parsed.fall_confidence = static_cast<double>(confidence);
    if (!std::isfinite(*parsed.fall_confidence) || *parsed.fall_confidence < 0.0 ||
        *parsed.fall_confidence > 1.0) {
      throw std::runtime_error("pose/fall confidence is outside [0,1]");
    }
  }
  return parsed;
}

}  // namespace

PoseFallClient::PoseFallClient(std::string socket_path)
    : socket_path_(std::move(socket_path)) {
  sockaddr_un address{};
  if (socket_path_.empty() || socket_path_.size() >= sizeof(address.sun_path)) {
    throw std::invalid_argument("invalid pose/fall Unix socket path");
  }
}

PoseFallResponse PoseFallClient::infer(
    const cv::Mat& frame_bgr, const TrackedPersonFrame& person) const {
  if (frame_bgr.empty() || frame_bgr.type() != CV_8UC3) {
    throw std::invalid_argument("pose/fall input must be a non-empty BGR8 frame");
  }
  const auto& box = person.bbox_xyxy;
  for (float coordinate : box) {
    if (!std::isfinite(coordinate)) throw std::invalid_argument("person bbox must be finite");
  }
  if (box[2] <= box[0] || box[3] <= box[1]) {
    throw std::invalid_argument("person bbox must have positive width and height");
  }

  std::vector<unsigned char> jpeg;
  if (!cv::imencode(".jpg", frame_bgr, jpeg, {cv::IMWRITE_JPEG_QUALITY, 85})) {
    throw std::runtime_error("unable to encode pose/fall frame as JPEG");
  }
  const std::string request =
      "{\"frame_id\":" + api::json_string(person.frame_id) +
      ",\"timestamp_ms\":" + std::to_string(person.timestamp_ms) +
      ",\"track_id\":" + std::to_string(person.track_id) +
      ",\"bbox_xyxy\":[" + api::json_number(box[0]) + "," +
      api::json_number(box[1]) + "," + api::json_number(box[2]) + "," +
      api::json_number(box[3]) + "],\"frame_jpeg_base64\":" +
      api::json_string(base64(jpeg)) + "}\n";

  const int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) {
    throw std::runtime_error(std::string{"unable to create pose/fall socket: "} + std::strerror(errno));
  }
  try {
    const timeval timeout{kSocketTimeoutSeconds, 0};
    if (setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0 ||
        setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0) {
      throw std::runtime_error(
          std::string{"unable to configure pose/fall socket timeout: "} + std::strerror(errno));
    }
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, socket_path_.c_str(), socket_path_.size() + 1U);
    if (connect(descriptor, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      throw std::runtime_error(
          std::string{"unable to connect to pose/fall worker: "} + std::strerror(errno));
    }
    write_all(descriptor, request);
    std::string response = read_line(descriptor);
    close_socket(descriptor);
    return parse_response(std::move(response));
  } catch (...) {
    close_socket(descriptor);
    throw;
  }
}

}  // namespace wardy::inference
