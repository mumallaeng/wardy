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
    if (argc > 1) config.port = parse_integer(argv[1], "port");
    if (argc > 2) config.camera.device_index = parse_integer(argv[2], "device index");
    if (argc > 3) config.camera.width = parse_integer(argv[3], "width");
    if (argc > 4) config.camera.height = parse_integer(argv[4], "height");
    if (argc > 5) config.database_path = argv[5];
    if (argc > 6) config.training_data_path = argv[6];
    if (argc > 7) throw std::invalid_argument("usage: wardy_edge_service [port] [device] [width] [height] [database] [training data]");

    std::signal(SIGINT, request_stop);
    std::signal(SIGTERM, request_stop);
    wardy::api::MjpegService service(config);
    return service.run(stop_requested);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
