#include "inference/pose_fall_client.hpp"

#include "api/json_serialization.hpp"

#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/core/persistence.hpp>
#include <opencv2/core/version.hpp>

namespace wardy::inference {
namespace {

constexpr std::size_t kMaximumResponseBytes = 1024U * 1024U;
constexpr long kSocketTimeoutSeconds = 5;

std::int64_t positive_track_id(const cv::FileNode& node,
                               const char* error_message) {
#if CV_VERSION_MAJOR > 4 || \
    (CV_VERSION_MAJOR == 4 && CV_VERSION_MINOR >= 11)
  if (!node.isInt()) throw std::runtime_error(error_message);
  const long double numeric_value = static_cast<long double>(
      static_cast<std::int64_t>(node));
#else
  // JetPack images with older OpenCV expose JSON numbers through int/double.
  // Accept only integers that round-trip exactly before converting to int64.
  if (!node.isInt() && !node.isReal()) throw std::runtime_error(error_message);
  const double raw_value = static_cast<double>(node);
  constexpr double kMaximumExactDoubleInteger = 9007199254740991.0;
  if (!std::isfinite(raw_value) || std::trunc(raw_value) != raw_value ||
      raw_value > kMaximumExactDoubleInteger) {
    throw std::runtime_error(error_message);
  }
  const long double numeric_value = static_cast<long double>(raw_value);
#endif
  if (numeric_value < 1.0L ||
      numeric_value > static_cast<long double>(
          std::numeric_limits<std::int64_t>::max())) {
    throw std::runtime_error(error_message);
  }
  return static_cast<std::int64_t>(numeric_value);
}

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

void parse_fall_result(const cv::FileNode& container,
                       std::optional<bool>& fall_suspected,
                       std::optional<double>& fall_confidence) {
  const cv::FileNode fall = container["fall"];
  if (fall.empty()) return;
  if (fall.type() != cv::FileNode::MAP) {
    throw std::runtime_error("pose/fall response contains an invalid fall result");
  }
  const cv::FileNode suspected = fall["fall_suspected"];
  const cv::FileNode confidence = fall["confidence"];
  if (suspected.empty() || !suspected.isInt() || confidence.empty() ||
      (!confidence.isInt() && !confidence.isReal())) {
    throw std::runtime_error("pose/fall response contains an invalid fall result");
  }
  fall_suspected = static_cast<int>(suspected) != 0;
  fall_confidence = static_cast<double>(confidence);
  if (!std::isfinite(*fall_confidence) || *fall_confidence < 0.0 ||
      *fall_confidence > 1.0) {
    throw std::runtime_error("pose/fall confidence is outside [0,1]");
  }
}

std::optional<std::string> optional_string(const cv::FileNode& container,
                                           const char* key) {
  const cv::FileNode value = container[key];
  if (value.empty() || value.isNone()) return std::nullopt;
  if (!value.isString()) {
    throw std::runtime_error(std::string{"tracking response identity contains invalid "} + key);
  }
  const auto parsed = static_cast<std::string>(value);
  return parsed.empty() ? std::nullopt : std::optional<std::string>{parsed};
}

void parse_identity_result(const cv::FileNode& container,
                           TrackedFallResult& person) {
  const cv::FileNode identity = container["identity"];
  if (identity.empty()) return;
  if (identity.type() != cv::FileNode::MAP) {
    throw std::runtime_error("tracking response contains an invalid identity result");
  }
  const cv::FileNode status = identity["status"];
  if (!status.isString()) {
    throw std::runtime_error("tracking response identity is missing status");
  }
  person.identity_status = static_cast<std::string>(status);
  person.subject_id = optional_string(identity, "subject_id");
  person.subject_name = optional_string(identity, "subject_name");
  person.subject_role = optional_string(identity, "subject_role");
  const cv::FileNode confidence = identity["confidence"];
  if (!confidence.empty() && !confidence.isNone()) {
    if (!confidence.isInt() && !confidence.isReal()) {
      throw std::runtime_error("tracking response identity contains invalid confidence");
    }
    const double parsed = static_cast<double>(confidence);
    if (!std::isfinite(parsed) || parsed < -1.0 || parsed > 1.0) {
      throw std::runtime_error("tracking response identity confidence is outside [-1,1]");
    }
    person.identity_confidence = parsed;
  }
  if (person.identity_status == "registered" &&
      (!person.subject_id || !person.subject_name || !person.subject_role)) {
    throw std::runtime_error("registered identity is missing subject metadata");
  }
}

std::array<float, 4> parse_bbox(const cv::FileNode& node,
                                const char* error_message) {
  if (node.type() != cv::FileNode::SEQ || node.size() != 4) {
    throw std::runtime_error(error_message);
  }
  std::array<float, 4> box{};
  std::size_t index = 0;
  for (const auto& coordinate : node) {
    if (!coordinate.isInt() && !coordinate.isReal()) {
      throw std::runtime_error(error_message);
    }
    box[index++] = static_cast<float>(coordinate);
  }
  if (!std::all_of(box.begin(), box.end(), [](float value) {
        return std::isfinite(value);
      }) || box[2] <= box[0] || box[3] <= box[1]) {
    throw std::runtime_error(error_message);
  }
  return box;
}

TrackingPoseFallResponse parse_tracking_response(std::string response) {
  cv::FileStorage document(response, cv::FileStorage::READ |
      cv::FileStorage::MEMORY | cv::FileStorage::FORMAT_JSON);
  if (!document.isOpened() || document.root().type() != cv::FileNode::MAP) {
    throw std::runtime_error("pose/fall worker returned invalid JSON");
  }
  TrackingPoseFallResponse parsed;
  parsed.raw_json = std::move(response);
  const cv::FileNode ok = document["ok"];
  if (ok.empty() || !ok.isInt()) {
    throw std::runtime_error("pose/fall response is missing boolean ok");
  }
  parsed.ok = static_cast<int>(ok) != 0;
  const cv::FileNode error = document["error"];
  if (!error.empty() && error.isString()) parsed.error = static_cast<std::string>(error);
  if (!parsed.ok) return parsed;

  const cv::FileNode active_tracks = document["active_track_ids"];
  const cv::FileNode persons = document["persons"];
  const cv::FileNode hazards = document["hazards"];
  if (active_tracks.type() != cv::FileNode::SEQ || persons.type() != cv::FileNode::SEQ ||
      (!hazards.empty() && hazards.type() != cv::FileNode::SEQ)) {
    throw std::runtime_error(
        "tracking response requires active_track_ids and persons arrays and an optional hazards array");
  }
  for (const auto& node : active_tracks) {
    parsed.active_track_ids.push_back(positive_track_id(
        node, "tracking response contains an invalid active track ID"));
  }
  for (const auto& node : persons) {
    if (node.type() != cv::FileNode::MAP) {
      throw std::runtime_error("tracking response contains an invalid person result");
    }
    const cv::FileNode track_id = node["track_id"];
    const cv::FileNode accepted = node["accepted"];
    const cv::FileNode confidence = node["detection_confidence"];
    if (!accepted.isInt() || (!confidence.isInt() && !confidence.isReal())) {
      throw std::runtime_error(
          "tracking response person is missing track_id, accepted, or detection_confidence");
    }
    TrackedFallResult person;
    person.track_id = positive_track_id(
        track_id,
        "tracking response person is missing track_id, accepted, or detection_confidence");
    person.accepted = static_cast<int>(accepted) != 0;
    person.bbox_xyxy = parse_bbox(
        node["bbox_xyxy"], "tracking response person contains an invalid bbox");
    person.detection_confidence = static_cast<float>(confidence);
    if (!std::isfinite(person.detection_confidence) ||
        person.detection_confidence < 0.0F || person.detection_confidence > 1.0F) {
      throw std::runtime_error("tracking response person confidence is outside [0,1]");
    }
    const cv::FileNode pose = node["pose"];
    if (!pose.empty()) {
      const cv::FileNode quality = pose["pose_quality"];
      if ((!quality.isInt() && !quality.isReal()) ||
          !std::isfinite(static_cast<double>(quality))) {
        throw std::runtime_error("tracking response person contains invalid pose quality");
      }
      person.pose_quality = static_cast<double>(quality);
    }
    parse_fall_result(node, person.fall_suspected, person.fall_confidence);
    parse_identity_result(node, person);
    parsed.persons.push_back(std::move(person));
  }
  for (const auto& node : hazards) {
    if (node.type() != cv::FileNode::MAP) {
      throw std::runtime_error("tracking response contains an invalid hazard result");
    }
    const cv::FileNode id = node["detection_id"];
    const cv::FileNode class_name = node["class_name"];
    const cv::FileNode confidence = node["confidence"];
    if (!id.isString() || !class_name.isString() ||
        (!confidence.isInt() && !confidence.isReal())) {
      throw std::runtime_error("tracking response hazard is incomplete");
    }
    HazardDetectionResult hazard;
    hazard.detection_id = static_cast<std::string>(id);
    hazard.class_name = static_cast<std::string>(class_name);
    hazard.bbox_xyxy = parse_bbox(
        node["bbox_xyxy"], "tracking response hazard contains an invalid bbox");
    hazard.confidence = static_cast<double>(confidence);
    if (hazard.detection_id.empty() || hazard.class_name.empty() ||
        !std::isfinite(hazard.confidence) || hazard.confidence < 0.0 ||
        hazard.confidence > 1.0) {
      throw std::runtime_error("tracking response hazard is invalid");
    }
    parsed.hazards.push_back(std::move(hazard));
  }
  return parsed;
}

std::string encoded_frame(const cv::Mat& frame_bgr) {
  if (frame_bgr.empty() || frame_bgr.type() != CV_8UC3) {
    throw std::invalid_argument("pose/fall input must be a non-empty BGR8 frame");
  }
  std::vector<unsigned char> jpeg;
  if (!cv::imencode(".jpg", frame_bgr, jpeg, {cv::IMWRITE_JPEG_QUALITY, 85})) {
    throw std::runtime_error("unable to encode pose/fall frame as JPEG");
  }
  return base64(jpeg);
}

std::string exchange_request(const std::string& socket_path,
                             const std::string& request) {
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
    std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1U);
    if (connect(descriptor, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      throw std::runtime_error(
          std::string{"unable to connect to pose/fall worker: "} + std::strerror(errno));
    }
    write_all(descriptor, request);
    std::string response = read_line(descriptor);
    close_socket(descriptor);
    return response;
  } catch (...) {
    close_socket(descriptor);
    throw;
  }
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
  const auto& box = person.bbox_xyxy;
  for (float coordinate : box) {
    if (!std::isfinite(coordinate)) throw std::invalid_argument("person bbox must be finite");
  }
  if (box[2] <= box[0] || box[3] <= box[1]) {
    throw std::invalid_argument("person bbox must have positive width and height");
  }

  const std::string request =
      "{\"frame_id\":" + api::json_string(person.frame_id) +
      ",\"timestamp_ms\":" + std::to_string(person.timestamp_ms) +
      ",\"track_id\":" + std::to_string(person.track_id) +
      ",\"bbox_xyxy\":[" + api::json_number(box[0]) + "," +
      api::json_number(box[1]) + "," + api::json_number(box[2]) + "," +
      api::json_number(box[3]) + "],\"frame_jpeg_base64\":" +
      api::json_string(encoded_frame(frame_bgr)) + "}\n";
  return parse_response(exchange_request(socket_path_, request));
}

TrackingPoseFallResponse PoseFallClient::infer_frame(
    const cv::Mat& frame_bgr, const std::string& frame_id,
    std::int64_t timestamp_ms, const std::vector<PersonDetection>& detections,
    bool reset_tracking) const {
  if (frame_id.empty()) throw std::invalid_argument("frame ID must not be empty");
  if (timestamp_ms < 0) throw std::invalid_argument("timestamp must be non-negative");
  std::string detection_json = "[";
  for (std::size_t index = 0; index < detections.size(); ++index) {
    const auto& detection = detections[index];
    const auto& box = detection.bbox_xyxy;
    for (float coordinate : box) {
      if (!std::isfinite(coordinate)) {
        throw std::invalid_argument("person detection bbox must be finite");
      }
    }
    if (box[2] <= box[0] || box[3] <= box[1] ||
        !std::isfinite(detection.confidence) || detection.confidence < 0.0F ||
        detection.confidence > 1.0F) {
      throw std::invalid_argument("invalid person detection");
    }
    if (index != 0) detection_json += ',';
    detection_json += "{\"bbox_xyxy\":[" + api::json_number(box[0]) + "," +
        api::json_number(box[1]) + "," + api::json_number(box[2]) + "," +
        api::json_number(box[3]) + "],\"confidence\":" +
        api::json_number(detection.confidence) + "}";
  }
  detection_json += ']';
  const std::string request =
      "{\"frame_id\":" + api::json_string(frame_id) +
      ",\"timestamp_ms\":" + std::to_string(timestamp_ms) +
      ",\"person_detections\":" + detection_json +
      ",\"reset_tracking\":" + (reset_tracking ? "true" : "false") +
      ",\"frame_jpeg_base64\":" + api::json_string(encoded_frame(frame_bgr)) +
      "}\n";
  return parse_tracking_response(exchange_request(socket_path_, request));
}

}  // namespace wardy::inference
