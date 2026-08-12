#include "inference/person_detector_postprocess.hpp"

#include <cassert>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace {

bool close(float first, float second) {
  return std::fabs(first - second) < 0.001F;
}

}  // namespace

int main() {
  // [1, 5, 3]: xywh channels followed by the single person score channel.
  const std::vector<float> output{
      320.0F, 322.0F, 100.0F,
      320.0F, 322.0F, 100.0F,
      200.0F, 200.0F, 40.0F,
      400.0F, 400.0F, 80.0F,
      0.95F, 0.90F, 0.20F,
  };
  const wardy::inference::LetterboxTransform transform{
      1.0F, 0.0F, 80.0F, 640, 480,
  };
  const auto detections = wardy::inference::decode_yolo11_person_output(
      output.data(), 3, 5, true, transform, 0.5F, 0.45F);
  assert(detections.size() == 1);
  assert(close(detections[0].confidence, 0.95F));
  assert(close(detections[0].bbox_xyxy[0], 220.0F));
  assert(close(detections[0].bbox_xyxy[1], 40.0F));
  assert(close(detections[0].bbox_xyxy[2], 420.0F));
  assert(close(detections[0].bbox_xyxy[3], 440.0F));

  bool rejected = false;
  try {
    (void)wardy::inference::decode_yolo11_person_output(
        output.data(), 3, 4, true, transform, 0.5F, 0.45F);
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  assert(rejected);
  return 0;
}
