#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <opencv2/core.hpp>

#include "inference/person_detector_postprocess.hpp"

namespace wardy::inference {

struct TrackedPersonFrame {
  std::string frame_id;
  std::int64_t timestamp_ms{};
  std::int64_t track_id{};
  std::array<float, 4> bbox_xyxy{};
};

struct PoseFallResponse {
  bool ok{};
  bool accepted{};
  std::optional<bool> fall_suspected;
  std::optional<double> fall_confidence;
  std::string error;
  std::string raw_json;
};

struct TrackedFallResult {
  std::int64_t track_id{};
  bool accepted{};
  std::array<float, 4> bbox_xyxy{};
  float detection_confidence{};
  std::optional<double> pose_quality;
  std::optional<bool> fall_suspected;
  std::optional<double> fall_confidence;
  std::string identity_status;
  std::optional<std::string> subject_id;
  std::optional<std::string> subject_name;
  std::optional<std::string> subject_role;
  std::optional<double> identity_confidence;
};

struct HazardDetectionResult {
  std::string detection_id;
  std::string class_name;
  std::array<float, 4> bbox_xyxy{};
  double confidence{};
};

struct TrackingPoseFallResponse {
  bool ok{};
  std::vector<std::int64_t> active_track_ids;
  std::vector<TrackedFallResult> persons;
  std::vector<HazardDetectionResult> hazards;
  std::string error;
  std::string raw_json;
};

class PoseFallClient {
 public:
  explicit PoseFallClient(std::string socket_path);

  // M-01/M-02 supplies the tracked person box. M-03/M-04 remain in the
  // persistent Python worker and return one JSON response per request.
  PoseFallResponse infer(const cv::Mat& frame_bgr, const TrackedPersonFrame& person) const;

  // M-01 supplies current-frame detections. The persistent Python worker owns
  // M-02 anonymous tracking and then executes M-03/M-04 per tracked person.
  TrackingPoseFallResponse infer_frame(
      const cv::Mat& frame_bgr, const std::string& frame_id,
      std::int64_t timestamp_ms, const std::vector<PersonDetection>& detections,
      bool reset_tracking = false) const;

 private:
  std::string socket_path_;
};

}  // namespace wardy::inference
