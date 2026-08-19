#pragma once

#include <array>
#include <cstddef>
#include <vector>

namespace wardy::inference {

struct PersonDetection {
  std::array<float, 4> bbox_xyxy{};
  float confidence{};
};

struct LetterboxTransform {
  float scale{};
  float pad_x{};
  float pad_y{};
  int source_width{};
  int source_height{};
};

// Ultralytics YOLO11 detection export emits xywh boxes followed by one score
// per class. The Wardy M-01 model has one class, person=0.
std::vector<PersonDetection> decode_yolo11_person_output(
    const float* output, std::size_t candidate_count, std::size_t channel_count,
    bool channels_first, const LetterboxTransform& transform,
    float confidence_threshold, float nms_iou_threshold,
    std::size_t person_class_index = 0);

}  // namespace wardy::inference
