#include "inference/pose_fall_client.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

#include <opencv2/imgcodecs.hpp>

int main(int argc, char** argv) {
  if (argc != 9) {
    std::cerr << "usage: " << argv[0]
              << " <socket> <image> <track_id> <timestamp_ms> <x1> <y1> <x2> <y2>\n";
    return 2;
  }
  try {
    const cv::Mat frame = cv::imread(argv[2], cv::IMREAD_COLOR);
    if (frame.empty()) throw std::runtime_error("unable to read input image");
    wardy::inference::TrackedPersonFrame person;
    person.frame_id = argv[2];
    person.track_id = std::stoll(argv[3]);
    person.timestamp_ms = std::stoll(argv[4]);
    for (int index = 0; index < 4; ++index) {
      person.bbox_xyxy[static_cast<std::size_t>(index)] = std::stof(argv[index + 5]);
    }
    const auto response = wardy::inference::PoseFallClient(argv[1]).infer(frame, person);
    std::cout << response.raw_json << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
