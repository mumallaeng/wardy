#include "input/camera_config.hpp"

#include <cassert>
#include <stdexcept>

int main() {
  wardy::input::CameraConfig config;
  assert(config.device_index == 0);
  assert(config.width == 640);
  assert(config.height == 480);
  assert(config.buffer_size == 1);
  config.validate();

  config.device_index = -1;
  try {
    config.validate();
    return 1;
  } catch (const std::invalid_argument&) {
  }

  config = {};
  config.width = 0;
  try {
    config.validate();
    return 2;
  } catch (const std::invalid_argument&) {
  }

  config = {};
  config.buffer_size = 0;
  try {
    config.validate();
    return 3;
  } catch (const std::invalid_argument&) {
  }

  return 0;
}
