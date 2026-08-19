#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>

#include <opencv2/core.hpp>

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

class PoseFallClient {
 public:
  explicit PoseFallClient(std::string socket_path);

  // M-01/M-02 supplies the tracked person box. M-03/M-04 remain in the
  // persistent Python worker and return one JSON response per request.
  PoseFallResponse infer(const cv::Mat& frame_bgr, const TrackedPersonFrame& person) const;

 private:
  std::string socket_path_;
};

}  // namespace wardy::inference
