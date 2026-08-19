#pragma once

#include <stdexcept>

namespace wardy::input {

struct CameraConfig {
  int device_index = 0;
  int width = 640;
  int height = 480;
  int buffer_size = 1;
  double requested_fps = 0.0;

  void validate() const {
    if (device_index < 0) {
      throw std::invalid_argument("camera device index must be zero or greater");
    }
    if (width <= 0 || height <= 0) {
      throw std::invalid_argument("camera width and height must be positive");
    }
    if (buffer_size <= 0) {
      throw std::invalid_argument("camera buffer size must be positive");
    }
    if (requested_fps < 0.0) {
      throw std::invalid_argument("requested camera FPS must not be negative");
    }
  }
};

}  // namespace wardy::input
