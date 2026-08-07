#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace wardy::analysis {

inline constexpr std::size_t kCocoKeypointCount = 17;

inline constexpr std::array<const char*, kCocoKeypointCount> kCocoKeypointNames{
    "nose",          "left_eye",      "right_eye",      "left_ear",
    "right_ear",     "left_shoulder", "right_shoulder", "left_elbow",
    "right_elbow",   "left_wrist",    "right_wrist",    "left_hip",
    "right_hip",     "left_knee",     "right_knee",     "left_ankle",
    "right_ankle",
};

struct BoundingBox {
  float x_min{0.0F};
  float y_min{0.0F};
  float x_max{0.0F};
  float y_max{0.0F};

  [[nodiscard]] float width() const noexcept { return x_max - x_min; }
  [[nodiscard]] float height() const noexcept { return y_max - y_min; }
  [[nodiscard]] bool valid() const noexcept {
    return std::isfinite(x_min) && std::isfinite(y_min) &&
           std::isfinite(x_max) && std::isfinite(y_max) && width() > 0.0F &&
           height() > 0.0F;
  }
};

struct Keypoint {
  float x{0.0F};
  float y{0.0F};
  float confidence{0.0F};
};

struct NormalizedPoint {
  float x{0.0F};
  float y{0.0F};
};

enum class Posture { unknown, standing, sitting, crouching, lying };

struct PoseObservation {
  std::uint64_t frame_id{0};
  std::uint64_t timestamp_ms{0};
  std::int64_t track_id{-1};
  BoundingBox person_box{};
  std::array<Keypoint, kCocoKeypointCount> keypoints{};
  float pose_quality{0.0F};
  Posture posture{Posture::unknown};
  float posture_confidence{0.0F};
};

[[nodiscard]] inline std::optional<NormalizedPoint> normalize_keypoint(
    const Keypoint& keypoint, const BoundingBox& box) noexcept {
  if (!box.valid() || !std::isfinite(keypoint.x) ||
      !std::isfinite(keypoint.y)) {
    return std::nullopt;
  }

  return NormalizedPoint{(keypoint.x - box.x_min) / box.width(),
                         (keypoint.y - box.y_min) / box.height()};
}

[[nodiscard]] inline float compute_pose_quality(
    const std::array<Keypoint, kCocoKeypointCount>& keypoints,
    float confidence_threshold) noexcept {
  if (!std::isfinite(confidence_threshold)) {
    return 0.0F;
  }
  if (confidence_threshold < 0.0F || confidence_threshold > 1.0F) {
    return 0.0F;
  }

  std::size_t valid_count = 0;
  for (const auto& keypoint : keypoints) {
    if (std::isfinite(keypoint.confidence) && keypoint.confidence <= 1.0F &&
        keypoint.confidence >= confidence_threshold) {
      ++valid_count;
    }
  }

  return static_cast<float>(valid_count) /
         static_cast<float>(kCocoKeypointCount);
}

[[nodiscard]] inline const char* posture_name(Posture posture) noexcept {
  switch (posture) {
    case Posture::standing:
      return "standing";
    case Posture::sitting:
      return "sitting";
    case Posture::crouching:
      return "crouching";
    case Posture::lying:
      return "lying";
    case Posture::unknown:
      return "unknown";
  }
  return "unknown";
}

}  // namespace wardy::analysis
