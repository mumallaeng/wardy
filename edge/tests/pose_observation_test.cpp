#include "analysis/pose_observation.hpp"

#include <array>
#include <cassert>
#include <cmath>
#include <limits>
#include <string_view>

int main() {
  using wardy::analysis::BoundingBox;
  using wardy::analysis::Keypoint;
  using wardy::analysis::Posture;
  using wardy::analysis::compute_pose_quality;
  using wardy::analysis::kCocoKeypointCount;
  using wardy::analysis::kCocoKeypointNames;
  using wardy::analysis::normalize_keypoint;
  using wardy::analysis::posture_name;

  static_assert(kCocoKeypointCount == 17);
  assert(std::string_view{kCocoKeypointNames[11]} == "left_hip");
  assert(std::string_view{kCocoKeypointNames[16]} == "right_ankle");

  const BoundingBox box{10.0F, 20.0F, 110.0F, 220.0F};
  const auto normalized = normalize_keypoint(Keypoint{60.0F, 120.0F, 0.9F}, box);
  assert(normalized.has_value());
  assert(std::abs(normalized->x - 0.5F) < 0.0001F);
  assert(std::abs(normalized->y - 0.5F) < 0.0001F);

  assert(!normalize_keypoint(Keypoint{}, BoundingBox{}).has_value());
  assert(!normalize_keypoint(
              Keypoint{std::numeric_limits<float>::quiet_NaN(), 0.0F, 0.0F},
              box)
              .has_value());

  std::array<Keypoint, kCocoKeypointCount> keypoints{};
  for (std::size_t index = 0; index < 12; ++index) {
    keypoints[index].confidence = 0.8F;
  }
  keypoints[0].confidence = std::numeric_limits<float>::quiet_NaN();
  keypoints[1].confidence = 1.1F;
  const auto quality = compute_pose_quality(keypoints, 0.5F);
  assert(std::abs(quality - (10.0F / 17.0F)) < 0.0001F);
  assert(compute_pose_quality(
             keypoints, std::numeric_limits<float>::quiet_NaN()) == 0.0F);
  assert(compute_pose_quality(keypoints, -0.1F) == 0.0F);

  assert(std::string_view{posture_name(Posture::standing)} == "standing");
  assert(std::string_view{posture_name(Posture::lying)} == "lying");
  assert(std::string_view{posture_name(Posture::unknown)} == "unknown");

  return 0;
}
