#pragma once

#include "inference/person_detector.hpp"

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <opencv2/core/mat.hpp>

namespace wardy::inference {

class PersonInferenceRuntime {
 public:
  using ResultCallback = std::function<void(
      const cv::Mat&, const std::string&, std::int64_t,
      const std::vector<PersonDetection>&, bool)>;
  using StatusCallback = std::function<void(bool, const std::string&)>;

  PersonInferenceRuntime(PersonDetectorConfig config, ResultCallback on_result,
                         StatusCallback on_status);
  ~PersonInferenceRuntime();

  PersonInferenceRuntime(const PersonInferenceRuntime&) = delete;
  PersonInferenceRuntime& operator=(const PersonInferenceRuntime&) = delete;

  // The queue holds only the newest frame. Capture never waits for inference.
  void submit(const cv::Mat& frame_bgr, std::string frame_id,
              std::int64_t timestamp_ms, bool reset_tracking = false);
  void stop();

 private:
  struct PendingFrame {
    cv::Mat frame_bgr;
    std::string frame_id;
    std::int64_t timestamp_ms{};
    bool reset_tracking{};
  };

  void worker_loop();

  PersonDetector detector_;
  ResultCallback on_result_;
  StatusCallback on_status_;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::optional<PendingFrame> pending_;
  bool running_ = true;
  std::thread worker_;
};

}  // namespace wardy::inference
