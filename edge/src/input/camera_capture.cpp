#include "input/camera_capture.hpp"

#include <opencv2/core/mat.hpp>
#include <opencv2/videoio.hpp>

#include <stdexcept>
#include <utility>

namespace wardy::input {

struct CameraCapture::Impl {
  /**
 * @brief Initializes the implementation with the camera configuration.
 *
 * @param camera_config Configuration used to operate the camera.
 */
explicit Impl(CameraConfig camera_config) : config(std::move(camera_config)) {}

  CameraConfig config;
  cv::VideoCapture capture;
};

/**
 * @brief Creates a camera capture with the specified configuration.
 *
 * @param config Camera device and capture settings to validate and store.
 */
CameraCapture::CameraCapture(CameraConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {
  impl_->config.validate();
}

CameraCapture::~CameraCapture() = default;
/**
 * @brief Transfers camera capture state from another instance.
 */
CameraCapture::CameraCapture(CameraCapture&&) noexcept = default;
CameraCapture& CameraCapture::operator=(CameraCapture&&) noexcept = default;

/**
 * @brief Opens the configured camera device.
 *
 * Closes any currently open device before opening the configured device and
 * applying its frame dimensions, buffer size, and optional frame-rate request.
 *
 * @throws std::logic_error If called on a moved-from camera capture.
 * @throws std::runtime_error If the camera device cannot be opened.
 */
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

/**
 * @brief Closes the camera device if it is open.
 */
void CameraCapture::close() noexcept {
  if (impl_ && impl_->capture.isOpened()) {
    impl_->capture.release();
  }
}

/**
 * @brief Reports whether the camera device is open.
 *
 * @return `true` if the camera device is open, `false` otherwise.
 */
bool CameraCapture::is_open() const noexcept {
  return impl_ && impl_->capture.isOpened();
}

/**
 * @brief Reports the current camera capture properties.
 *
 * @return Camera width, height, frame rate, and backend identifier.
 * @throws std::logic_error If the camera is not open.
 */
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

/**
 * @brief Captures the next frame from the camera.
 *
 * @param frame Destination matrix for the captured frame.
 * @return `true` if a non-empty frame was captured, `false` otherwise.
 * @throws std::logic_error If the camera is not open.
 */
bool CameraCapture::read(cv::Mat& frame) {
  if (!is_open()) {
    throw std::logic_error("camera frame requested before opening the device");
  }
  return impl_->capture.read(frame) && !frame.empty();
}

}  // namespace wardy::input
