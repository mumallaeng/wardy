#include "inference/person_detector_postprocess.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace wardy::inference {
namespace {

float output_value(const float* output, std::size_t candidate,
                   std::size_t channel, std::size_t candidate_count,
                   std::size_t channel_count, bool channels_first) {
  return channels_first ? output[channel * candidate_count + candidate]
                        : output[candidate * channel_count + channel];
}

float intersection_over_union(const PersonDetection& first,
                              const PersonDetection& second) {
  const float x1 = std::max(first.bbox_xyxy[0], second.bbox_xyxy[0]);
  const float y1 = std::max(first.bbox_xyxy[1], second.bbox_xyxy[1]);
  const float x2 = std::min(first.bbox_xyxy[2], second.bbox_xyxy[2]);
  const float y2 = std::min(first.bbox_xyxy[3], second.bbox_xyxy[3]);
  const float intersection = std::max(0.0F, x2 - x1) * std::max(0.0F, y2 - y1);
  const float first_area = (first.bbox_xyxy[2] - first.bbox_xyxy[0]) *
                           (first.bbox_xyxy[3] - first.bbox_xyxy[1]);
  const float second_area = (second.bbox_xyxy[2] - second.bbox_xyxy[0]) *
                            (second.bbox_xyxy[3] - second.bbox_xyxy[1]);
  return intersection /
         std::max(first_area + second_area - intersection, 1.0e-6F);
}

}  // namespace

std::vector<PersonDetection> decode_yolo11_person_output(
    const float* output, std::size_t candidate_count, std::size_t channel_count,
    bool channels_first, const LetterboxTransform& transform,
    float confidence_threshold, float nms_iou_threshold,
    std::size_t person_class_index) {
  if (output == nullptr) throw std::invalid_argument("YOLO output must not be null");
  if (candidate_count == 0 || channel_count < 5 ||
      person_class_index >= channel_count - 4) {
    throw std::invalid_argument("invalid YOLO11 output dimensions");
  }
  if (!std::isfinite(transform.scale) || transform.scale <= 0.0F ||
      transform.source_width <= 0 || transform.source_height <= 0) {
    throw std::invalid_argument("invalid letterbox transform");
  }
  if (!std::isfinite(confidence_threshold) || confidence_threshold < 0.0F ||
      confidence_threshold > 1.0F || !std::isfinite(nms_iou_threshold) ||
      nms_iou_threshold < 0.0F || nms_iou_threshold > 1.0F) {
    throw std::invalid_argument("detection thresholds must be inside [0,1]");
  }

  std::vector<PersonDetection> candidates;
  candidates.reserve(candidate_count);
  for (std::size_t candidate = 0; candidate < candidate_count; ++candidate) {
    const float confidence = output_value(
        output, candidate, 4 + person_class_index, candidate_count,
        channel_count, channels_first);
    if (!std::isfinite(confidence) || confidence < confidence_threshold) continue;

    const float center_x = output_value(
        output, candidate, 0, candidate_count, channel_count, channels_first);
    const float center_y = output_value(
        output, candidate, 1, candidate_count, channel_count, channels_first);
    const float width = output_value(
        output, candidate, 2, candidate_count, channel_count, channels_first);
    const float height = output_value(
        output, candidate, 3, candidate_count, channel_count, channels_first);
    if (!std::isfinite(center_x) || !std::isfinite(center_y) ||
        !std::isfinite(width) || !std::isfinite(height) ||
        width <= 0.0F || height <= 0.0F) {
      continue;
    }

    PersonDetection detection;
    detection.confidence = confidence;
    detection.bbox_xyxy = {
        std::clamp((center_x - width / 2.0F - transform.pad_x) /
                       transform.scale,
                   0.0F, static_cast<float>(transform.source_width)),
        std::clamp((center_y - height / 2.0F - transform.pad_y) /
                       transform.scale,
                   0.0F, static_cast<float>(transform.source_height)),
        std::clamp((center_x + width / 2.0F - transform.pad_x) /
                       transform.scale,
                   0.0F, static_cast<float>(transform.source_width)),
        std::clamp((center_y + height / 2.0F - transform.pad_y) /
                       transform.scale,
                   0.0F, static_cast<float>(transform.source_height)),
    };
    if (detection.bbox_xyxy[2] > detection.bbox_xyxy[0] &&
        detection.bbox_xyxy[3] > detection.bbox_xyxy[1]) {
      candidates.push_back(detection);
    }
  }

  std::sort(candidates.begin(), candidates.end(),
            [](const PersonDetection& first, const PersonDetection& second) {
              return first.confidence > second.confidence;
            });
  std::vector<PersonDetection> selected;
  selected.reserve(candidates.size());
  for (const auto& candidate : candidates) {
    const bool overlaps = std::any_of(
        selected.begin(), selected.end(), [&](const PersonDetection& kept) {
          return intersection_over_union(candidate, kept) > nms_iou_threshold;
        });
    if (!overlaps) selected.push_back(candidate);
  }
  return selected;
}

}  // namespace wardy::inference
