#pragma once

#include "storage/sqlite_store.hpp"

#include <opencv2/core/mat.hpp>

#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <functional>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace wardy::media {

class EventMediaRecorder {
 public:
  using ChangeCallback = std::function<void()>;

  EventMediaRecorder(std::filesystem::path root, storage::SqliteStore& database,
                     ChangeCallback on_change = {});
  ~EventMediaRecorder();

  EventMediaRecorder(const EventMediaRecorder&) = delete;
  EventMediaRecorder& operator=(const EventMediaRecorder&) = delete;

  void push_frame(const cv::Mat& frame);
  void schedule(const storage::EventRecord& event);
  void stop();
  [[nodiscard]] const std::filesystem::path& root_path() const noexcept { return root_; }

 private:
  struct TimedFrame {
    std::chrono::system_clock::time_point captured_at;
    cv::Mat frame;
  };

  void record_image(storage::EventRecord event);
  void record_video(storage::EventRecord event);
  void finish(const storage::EventRecord& event, const std::string& media_type,
              const std::filesystem::path& relative_path,
              const std::chrono::system_clock::time_point& started_at,
              const std::chrono::system_clock::time_point& ended_at);
  void release_schedule(const std::string& event_id) noexcept;

  std::filesystem::path root_;
  storage::SqliteStore& database_;
  ChangeCallback on_change_;
  std::mutex mutex_;
  std::condition_variable frame_ready_;
  std::vector<TimedFrame> ring_;
  std::set<std::string> scheduled_;
  std::vector<std::thread> workers_;
  std::size_t frame_sequence_ = 0;
  std::chrono::steady_clock::time_point next_ring_frame_{};
  bool running_ = true;
};

}  // namespace wardy::media
