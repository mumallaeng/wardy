#include "input/camera_config.hpp"

#include <stdexcept>

int main() {
  wardy::input::CameraConfig config;
  if (config.device_index != 0) return 10;
  if (config.width != 640) return 11;
  if (config.height != 480) return 12;
  if (config.buffer_size != 1) return 13;
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
