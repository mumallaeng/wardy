#include "input/camera_capture.hpp"

#include <opencv2/core/mat.hpp>
#include <opencv2/videoio.hpp>

#include <stdexcept>
#include <utility>

namespace wardy::input {

struct CameraCapture::Impl {
  explicit Impl(CameraConfig camera_config) : config(std::move(camera_config)) {}

  CameraConfig config;
  cv::VideoCapture capture;
};

CameraCapture::CameraCapture(CameraConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {
  impl_->config.validate();
}

CameraCapture::~CameraCapture() = default;
CameraCapture::CameraCapture(CameraCapture&&) noexcept = default;
CameraCapture& CameraCapture::operator=(CameraCapture&&) noexcept = default;

void CameraCapture::open() {
  if (!impl_) {
    throw std::logic_error("cannot open a moved-from camera capture");
  }
  close();

  // The Korcham Jetson labs use a USB webcam at /dev/video0 through V4L2.
  if (!impl_->capture.open(impl_->config.device_index, cv::CAP_V4L2)) {
    throw std::runtime_error("failed to open the Jetson V4L2 camera device");
  }

  impl_->capture.set(cv::CAP_PROP_FRAME_WIDTH, impl_->config.width);
  impl_->capture.set(cv::CAP_PROP_FRAME_HEIGHT, impl_->config.height);
  impl_->capture.set(cv::CAP_PROP_BUFFERSIZE, impl_->config.buffer_size);
  if (impl_->config.requested_fps > 0.0) {
    impl_->capture.set(cv::CAP_PROP_FPS, impl_->config.requested_fps);
  }
}

void CameraCapture::close() noexcept {
  if (impl_ && impl_->capture.isOpened()) {
    impl_->capture.release();
  }
}

bool CameraCapture::is_open() const noexcept {
  return impl_ && impl_->capture.isOpened();
}

CameraProperties CameraCapture::properties() const {
  if (!is_open()) {
    throw std::logic_error("camera properties requested before opening the device");
  }
  return {
      static_cast<int>(impl_->capture.get(cv::CAP_PROP_FRAME_WIDTH)),
      static_cast<int>(impl_->capture.get(cv::CAP_PROP_FRAME_HEIGHT)),
      impl_->capture.get(cv::CAP_PROP_FPS),
      static_cast<int>(impl_->capture.get(cv::CAP_PROP_BACKEND)),
  };
}

bool CameraCapture::read(cv::Mat& frame) {
  if (!is_open()) {
    throw std::logic_error("camera frame requested before opening the device");
  }
  return impl_->capture.read(frame) && !frame.empty();
}

}  // namespace wardy::input
