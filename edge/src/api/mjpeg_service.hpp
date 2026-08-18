#pragma once

#include <atomic>
#include <string>

#include "input/camera_config.hpp"

namespace wardy::api {

struct MjpegServiceConfig {
  input::CameraConfig camera;
  int port = 8787;
  int jpeg_quality = 80;
  std::string database_path = "edge/db/wardy.sqlite";
  std::string training_data_path = "edge/data/training";
  std::string event_media_path = "edge/data/events";
  std::string allowed_origin = "http://localhost:8000";
  std::string access_token;
  bool llm_enabled = true;
  std::string llm_model = "nemotron-3-nano:4b";
  int llm_timeout_seconds = 30;
  std::string person_detector_engine_path;
  float person_confidence_threshold = 0.35F;
  float person_nms_iou_threshold = 0.45F;
  int person_class_index = 0;
  std::string pose_fall_socket_path = "edge/run/pose-fall.sock";
  std::string inference_source = "auto";
  std::string temporary_inference_scenario = "normal";

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
