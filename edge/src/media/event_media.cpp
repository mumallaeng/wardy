#include "media/event_media.hpp"

#include <opencv2/imgcodecs.hpp>
#include <opencv2/videoio.hpp>

#include <algorithm>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace wardy::media {
namespace {

std::string iso_utc(const std::chrono::system_clock::time_point& point) {
  const std::time_t time = std::chrono::system_clock::to_time_t(point);
  std::tm value{};
  gmtime_r(&time, &value);
  std::ostringstream stream;
  stream << std::put_time(&value, "%Y-%m-%dT%H:%M:%SZ");
  return stream.str();
}

}  // namespace

EventMediaRecorder::EventMediaRecorder(std::filesystem::path root,
                                       storage::SqliteStore& database,
                                       ChangeCallback on_change,
                                       EventMediaOptions options)
    : root_(std::move(root)), database_(database), on_change_(std::move(on_change)),
      options_(options) {
  if (root_.empty()) throw std::invalid_argument("event media path must not be empty");
  if (options_.ring_interval.count() <= 0 || options_.before_event.count() < 0 ||
      options_.after_event.count() <= 0 || options_.frames_per_second <= 0.0) {
    throw std::invalid_argument("event media timing options are invalid");
  }
  std::filesystem::create_directories(root_);
}

EventMediaRecorder::~EventMediaRecorder() { stop(); }

void EventMediaRecorder::push_frame(const cv::Mat& frame) {
  if (frame.empty()) return;
  const auto steady_now = std::chrono::steady_clock::now();
  std::lock_guard lock(mutex_);
  if (!running_ || steady_now < next_ring_frame_) return;
  next_ring_frame_ = steady_now + options_.ring_interval;
  ring_.push_back({std::chrono::system_clock::now(), frame.clone()});
  ++frame_sequence_;
  if (ring_.size() > 60U) ring_.erase(ring_.begin(), ring_.begin() + (ring_.size() - 60U));
  frame_ready_.notify_all();
}

void EventMediaRecorder::schedule(const storage::EventRecord& event) {
  if (event.media_type == "none" || event.media_path) return;
  std::lock_guard lock(mutex_);
  if (!running_ || !scheduled_.insert(event.event_id).second) return;
  workers_.emplace_back([this, event] {
    try {
      if (event.media_type == "image") record_image(event);
      else if (event.media_type == "video") record_video(event);
    } catch (const std::exception& error) {
      std::cerr << "Event media error for " << event.event_id << ": " << error.what() << '\n';
      release_schedule(event.event_id);
    }
  });
}

void EventMediaRecorder::record_image(storage::EventRecord event) {
  TimedFrame selected;
  {
    std::unique_lock lock(mutex_);
    frame_ready_.wait_for(lock, std::chrono::seconds(2), [&] {
      return !running_ || !ring_.empty();
    });
    if (!running_ || ring_.empty()) throw std::runtime_error("camera frame is unavailable");
    selected = {ring_.back().captured_at, ring_.back().frame.clone()};
  }
  const std::filesystem::path relative = event.event_id + ".jpg";
  const std::filesystem::path temporary = root_ / (event.event_id + ".tmp.jpg");
  const std::filesystem::path final = root_ / relative;
  if (!cv::imwrite(temporary.string(), selected.frame,
                   {cv::IMWRITE_JPEG_QUALITY, 88})) {
    throw std::runtime_error("failed to encode event image");
  }
  std::filesystem::rename(temporary, final);
  finish(event, "image", relative, selected.captured_at, selected.captured_at);
}

void EventMediaRecorder::record_video(storage::EventRecord event) {
  const auto trigger = std::chrono::system_clock::now();
  const auto cutoff = trigger - options_.before_event;
  const auto complete_at = trigger + options_.after_event;
  std::vector<TimedFrame> frames;
  {
    std::unique_lock lock(mutex_);
    std::copy_if(ring_.begin(), ring_.end(), std::back_inserter(frames),
                 [&](const TimedFrame& frame) { return frame.captured_at >= cutoff; });
    while (running_ && std::chrono::system_clock::now() < complete_at) {
      const std::size_t previous_sequence = frame_sequence_;
      frame_ready_.wait_until(lock, complete_at, [&] {
        return !running_ || frame_sequence_ != previous_sequence;
      });
      if (!ring_.empty() && (frames.empty() ||
          ring_.back().captured_at > frames.back().captured_at)) {
        frames.push_back({ring_.back().captured_at, ring_.back().frame.clone()});
      }
    }
  }
  if (frames.size() < 2U) throw std::runtime_error("not enough camera frames for event video");
  const std::filesystem::path relative = event.event_id + ".mp4";
  const std::filesystem::path temporary = root_ / (event.event_id + ".tmp.mp4");
  const std::filesystem::path final = root_ / relative;
  const cv::Size size(frames.front().frame.cols, frames.front().frame.rows);
  cv::VideoWriter writer;
  const std::string pipeline = "appsrc ! videoconvert ! x264enc tune=zerolatency "
      "speed-preset=ultrafast bitrate=1800 key-int-max=15 ! h264parse ! mp4mux ! "
      "filesink location=\"" + temporary.string() + "\"";
  writer.open(pipeline, cv::CAP_GSTREAMER, 0, options_.frames_per_second, size, true);
  if (!writer.isOpened()) {
    writer.open(temporary.string(), cv::VideoWriter::fourcc('m', 'p', '4', 'v'),
                options_.frames_per_second, size, true);
  }
  if (!writer.isOpened()) throw std::runtime_error("failed to open event video encoder");
  for (const auto& frame : frames) writer.write(frame.frame);
  writer.release();
  std::filesystem::rename(temporary, final);
  finish(event, "video", relative, frames.front().captured_at, frames.back().captured_at);
}

void EventMediaRecorder::finish(
    const storage::EventRecord& event, const std::string& media_type,
    const std::filesystem::path& relative_path,
    const std::chrono::system_clock::time_point& started_at,
    const std::chrono::system_clock::time_point& ended_at) {
  if (!database_.update_event_media(event.event_id, media_type,
                                    relative_path.generic_string(),
                                    iso_utc(started_at), iso_utc(ended_at))) {
    std::error_code error;
    std::filesystem::remove(root_ / relative_path, error);
    throw std::runtime_error("event was removed before media metadata was saved");
  }
  release_schedule(event.event_id);
  if (on_change_) on_change_();
}

void EventMediaRecorder::release_schedule(const std::string& event_id) noexcept {
  std::lock_guard lock(mutex_);
  scheduled_.erase(event_id);
}

void EventMediaRecorder::stop() {
  {
    std::lock_guard lock(mutex_);
    if (!running_) return;
    running_ = false;
  }
  frame_ready_.notify_all();
  for (auto& worker : workers_) if (worker.joinable()) worker.join();
  workers_.clear();
}

}  // namespace wardy::media
