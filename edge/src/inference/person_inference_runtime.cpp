#include "inference/person_inference_runtime.hpp"

#include <exception>
#include <utility>

namespace wardy::inference {

PersonInferenceRuntime::PersonInferenceRuntime(
    PersonDetectorConfig config, ResultCallback on_result,
    StatusCallback on_status)
    : detector_(std::move(config)),
      on_result_(std::move(on_result)),
      on_status_(std::move(on_status)),
      worker_(&PersonInferenceRuntime::worker_loop, this) {}

PersonInferenceRuntime::~PersonInferenceRuntime() {
  stop();
}

void PersonInferenceRuntime::submit(const cv::Mat& frame_bgr,
                                    std::string frame_id,
                                    std::int64_t timestamp_ms,
                                    bool reset_tracking) {
  if (frame_bgr.empty()) return;
  {
    std::lock_guard lock(mutex_);
    if (!running_) return;
    // A reconnect reset must survive if a newer frame replaces the first
    // post-reconnect frame before the worker consumes it.
    reset_tracking = reset_tracking ||
        (pending_.has_value() && pending_->reset_tracking);
    pending_ = PendingFrame{
        frame_bgr.clone(), std::move(frame_id), timestamp_ms, reset_tracking};
  }
  ready_.notify_one();
}

void PersonInferenceRuntime::stop() {
  {
    std::lock_guard lock(mutex_);
    running_ = false;
    pending_.reset();
  }
  ready_.notify_all();
  if (worker_.joinable()) worker_.join();
}

void PersonInferenceRuntime::worker_loop() {
  if (on_status_) on_status_(true, "M-01 person detector is ready");
  bool fault_reported = false;
  bool reset_after_fault = false;
  while (true) {
    PendingFrame current;
    {
      std::unique_lock lock(mutex_);
      ready_.wait(lock, [this] { return !running_ || pending_.has_value(); });
      if (!running_) return;
      current = std::move(*pending_);
      pending_.reset();
    }
    try {
      const auto detections = detector_.detect(current.frame_bgr);
      if (on_result_) {
        on_result_(current.frame_bgr, current.frame_id, current.timestamp_ms,
                   detections, current.reset_tracking || reset_after_fault);
      }
      reset_after_fault = false;
      if (fault_reported && on_status_) {
        on_status_(true, "M-01 through M-04 inference pipeline recovered");
        fault_reported = false;
      }
    } catch (const std::exception& error) {
      reset_after_fault = true;
      if (!fault_reported && on_status_) {
        on_status_(false, error.what());
        fault_reported = true;
      }
    }
  }
}

}  // namespace wardy::inference
