#include "api/mjpeg_service.hpp"

#include <atomic>
#include <csignal>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

std::atomic_bool stop_requested{false};

void request_stop(int) {
  stop_requested = true;
}

int parse_integer(const char* value, const char* name) {
  try {
    std::size_t parsed = 0;
    const int result = std::stoi(value, &parsed);
    if (value[parsed] != '\0') throw std::invalid_argument("trailing characters");
    return result;
  } catch (const std::exception&) {
    throw std::invalid_argument(std::string{name} + " must be an integer");
  }
}

float parse_float(const char* value, const char* name) {
  try {
    std::size_t parsed = 0;
    const float result = std::stof(value, &parsed);
    if (value[parsed] != '\0') throw std::invalid_argument("trailing characters");
    return result;
  } catch (const std::exception&) {
    throw std::invalid_argument(std::string{name} + " must be a number");
  }
}

bool parse_boolean(const char* value, const char* name) {
  const std::string text = value;
  if (text == "true" || text == "1") return true;
  if (text == "false" || text == "0") return false;
  throw std::invalid_argument(std::string{name} + " must be true, false, 1, or 0");
}

}  // namespace

int main(int argc, char* argv[]) {
  try {
    wardy::api::MjpegServiceConfig config;
    if (const char* pipeline = std::getenv("WARDY_CAMERA_PIPELINE")) {
      config.camera.gstreamer_pipeline = pipeline;
    }
    if (const char* allowed_origin = std::getenv("WARDY_UI_ORIGIN")) {
      config.allowed_origin = allowed_origin;
    }
    if (const char* access_token = std::getenv("WARDY_ACCESS_TOKEN")) {
      config.access_token = access_token;
    }
    if (const char* enabled = std::getenv("WARDY_LLM_ENABLED")) {
      config.llm_enabled = parse_boolean(enabled, "WARDY_LLM_ENABLED");
    }
    if (const char* model = std::getenv("WARDY_LLM_MODEL")) {
      config.llm_model = model;
    }
    if (const char* timeout = std::getenv("WARDY_LLM_TIMEOUT_SECONDS")) {
      config.llm_timeout_seconds = parse_integer(timeout, "WARDY_LLM_TIMEOUT_SECONDS");
    }
    if (const char* engine = std::getenv("WARDY_PERSON_ENGINE")) {
      config.person_detector_engine_path = engine;
    }
    if (const char* confidence = std::getenv("WARDY_PERSON_CONFIDENCE")) {
      config.person_confidence_threshold = parse_float(
          confidence, "WARDY_PERSON_CONFIDENCE");
    }
    if (const char* iou = std::getenv("WARDY_PERSON_NMS_IOU")) {
      config.person_nms_iou_threshold = parse_float(iou, "WARDY_PERSON_NMS_IOU");
    }
    if (const char* class_index = std::getenv("WARDY_PERSON_CLASS_INDEX")) {
      config.person_class_index = parse_integer(
          class_index, "WARDY_PERSON_CLASS_INDEX");
    }
    if (argc > 1) config.port = parse_integer(argv[1], "port");
    if (argc > 2) config.camera.device_index = parse_integer(argv[2], "device index");
    if (argc > 3) config.camera.width = parse_integer(argv[3], "width");
    if (argc > 4) config.camera.height = parse_integer(argv[4], "height");
    if (argc > 5) config.database_path = argv[5];
    if (argc > 6) config.training_data_path = argv[6];
    if (argc > 7) config.event_media_path = argv[7];
    if (argc > 8) throw std::invalid_argument("usage: wardy_edge_service [port] [device] [width] [height] [database] [training data] [event media]");

    std::signal(SIGINT, request_stop);
    std::signal(SIGTERM, request_stop);
    wardy::api::MjpegService service(config);
    return service.run(stop_requested);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
