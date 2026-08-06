#pragma once

#include <atomic>

#include "input/camera_config.hpp"

namespace wardy::api {

struct MjpegServiceConfig {
  input::CameraConfig camera;
  int port = 8787;
  int jpeg_quality = 80;

  void validate() const;
};

class MjpegService {
 public:
  explicit MjpegService(MjpegServiceConfig config = {});

  MjpegService(const MjpegService&) = delete;
  MjpegService& operator=(const MjpegService&) = delete;

  int run(const std::atomic_bool& stop_requested);

 private:
  MjpegServiceConfig config_;
};

}  // namespace wardy::api
