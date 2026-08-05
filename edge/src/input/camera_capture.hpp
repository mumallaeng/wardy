#pragma once

#include <memory>

#include "input/camera_config.hpp"

namespace cv {
class Mat;
}

namespace wardy::input {

struct CameraProperties {
  int width = 0;
  int height = 0;
  double fps = 0.0;
  int backend = 0;
};

class CameraCapture {
 public:
  explicit CameraCapture(CameraConfig config = {});
  ~CameraCapture();

  CameraCapture(const CameraCapture&) = delete;
  CameraCapture& operator=(const CameraCapture&) = delete;
  CameraCapture(CameraCapture&&) noexcept;
  CameraCapture& operator=(CameraCapture&&) noexcept;

  void open();
  void close() noexcept;
  [[nodiscard]] bool is_open() const noexcept;
  [[nodiscard]] CameraProperties properties() const;
  bool read(cv::Mat& frame);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace wardy::input
