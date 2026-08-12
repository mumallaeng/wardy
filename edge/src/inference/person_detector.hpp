#pragma once

#include "inference/person_detector_postprocess.hpp"

#include <memory>
#include <string>
#include <vector>

#include <opencv2/core/mat.hpp>

namespace wardy::inference {

struct PersonDetectorConfig {
  std::string engine_path;
  float confidence_threshold = 0.5F;
  float nms_iou_threshold = 0.45F;
  std::size_t person_class_index = 0;

  void validate() const;
};

class PersonDetector {
 public:
  explicit PersonDetector(PersonDetectorConfig config);
  ~PersonDetector();

  PersonDetector(const PersonDetector&) = delete;
  PersonDetector& operator=(const PersonDetector&) = delete;

  std::vector<PersonDetection> detect(const cv::Mat& frame_bgr);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace wardy::inference
