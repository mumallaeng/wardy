#include "input/camera_capture.hpp"

#include <opencv2/core/mat.hpp>

#include <charconv>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

namespace {

int parse_integer(std::string_view value, std::string_view name) {
  int result = 0;
  const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), result);
  if (error != std::errc{} || end != value.data() + value.size()) {
    throw std::invalid_argument(std::string(name) + " must be an integer");
  }
  return result;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    wardy::input::CameraConfig config;
    int frames_to_read = 30;

    if (argc > 1) config.device_index = parse_integer(argv[1], "device index");
    if (argc > 2) config.width = parse_integer(argv[2], "width");
    if (argc > 3) config.height = parse_integer(argv[3], "height");
    if (argc > 4) frames_to_read = parse_integer(argv[4], "frame count");
    if (frames_to_read <= 0) throw std::invalid_argument("frame count must be positive");

    wardy::input::CameraCapture camera(config);
    camera.open();
    const auto properties = camera.properties();
    std::cout << "camera_open backend=" << properties.backend << " width=" << properties.width
              << " height=" << properties.height << " fps=" << properties.fps << '\n';

    cv::Mat frame;
    for (int count = 0; count < frames_to_read; ++count) {
      if (!camera.read(frame)) {
        std::cerr << "camera_read_failed frame=" << count << '\n';
        return 2;
      }
    }

    std::cout << "camera_read_ok frames=" << frames_to_read << " channels=" << frame.channels() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "camera_probe_error: " << error.what() << '\n';
    return 1;
  }
}
