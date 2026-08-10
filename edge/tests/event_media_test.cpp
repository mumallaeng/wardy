#include "media/event_media.hpp"
#include "storage/sqlite_store.hpp"

#include <opencv2/core.hpp>

#undef NDEBUG
#include <cassert>
#include <chrono>
#include <filesystem>
#include <thread>

namespace {

wardy::storage::EventRecord event(const std::string& id, const std::string& media_type) {
  wardy::storage::EventRecord value;
  value.event_id = id;
  value.event_type = media_type == "image" ? "hazard_detected" : "fall_suspected";
  value.occurred_at = "2026-08-10T00:00:00Z";
  value.first_seen_at = value.occurred_at;
  value.last_seen_at = value.occurred_at;
  value.subject_location = "test";
  value.care_status = media_type == "image" ? "caution" : "emergency";
  value.event_status = "new";
  value.reason = "media test";
  value.media_type = media_type;
  return value;
}

}  // namespace

int main() {
  const auto root = std::filesystem::temp_directory_path() / "wardy-event-media-test";
  std::filesystem::remove_all(root);
  wardy::storage::SqliteStore database(":memory:");
  database.initialize();
  const auto image_event = event("EVT-IMAGE", "image");
  const auto video_event = event("EVT-VIDEO", "video");
  database.upsert_event(image_event);
  database.upsert_event(video_event);

  wardy::media::EventMediaOptions options;
  options.ring_interval = std::chrono::milliseconds(5);
  options.before_event = std::chrono::milliseconds(30);
  options.after_event = std::chrono::milliseconds(60);
  options.frames_per_second = 20.0;
  wardy::media::EventMediaRecorder recorder(root, database, {}, options);
  const cv::Mat frame(48, 64, CV_8UC3, cv::Scalar(20, 80, 160));
  for (int index = 0; index < 8; ++index) {
    recorder.push_frame(frame);
    std::this_thread::sleep_for(std::chrono::milliseconds(6));
  }
  recorder.schedule(image_event);
  recorder.schedule(video_event);
  for (int index = 0; index < 15; ++index) {
    recorder.push_frame(frame);
    std::this_thread::sleep_for(std::chrono::milliseconds(6));
  }
  recorder.stop();

  const auto stored_image = database.get_event(image_event.event_id);
  const auto stored_video = database.get_event(video_event.event_id);
  assert(stored_image->media_path.has_value());
  assert(stored_video->media_path.has_value());
  assert(std::filesystem::file_size(root / *stored_image->media_path) > 0U);
  assert(std::filesystem::file_size(root / *stored_video->media_path) > 0U);
  std::filesystem::remove_all(root);
  return 0;
}
