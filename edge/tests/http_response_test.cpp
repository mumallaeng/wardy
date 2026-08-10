#include "api/http_response.hpp"

#include <iostream>
#include <string>

int main() {
  const auto expect = [](bool condition, const char* message) {
    if (!condition) std::cerr << message << '\n';
    return condition;
  };
  const std::string origin = "http://192.168.0.20:8000";
  const std::string health = wardy::api::health_response(true, origin);
  if (!expect(health.find("HTTP/1.1 200 OK") != std::string::npos, "missing 200 status") ||
      !expect(health.find("Access-Control-Allow-Origin: " + origin) != std::string::npos,
              "missing configured origin") ||
      !expect(health.find("Access-Control-Allow-Origin: *") == std::string::npos,
              "wildcard origin must not be allowed") ||
      !expect(health.find("X-Wardy-Access-Token") != std::string::npos, "missing access header") ||
      !expect(health.find("X-Wardy-Item-Id") != std::string::npos, "missing item header") ||
      !expect(health.find("X-Wardy-Subject-Id") != std::string::npos, "missing subject header") ||
      !expect(health.find("GET, POST, DELETE, OPTIONS") != std::string::npos, "missing methods") ||
      !expect(health.find("\"camera\":\"connected\"") != std::string::npos,
              "wrong connected health body")) return 1;

  const std::string fault = wardy::api::health_response(false, origin);
  if (!expect(fault.find("\"camera\":\"fault\"") != std::string::npos,
              "wrong fault health body")) return 2;

  const std::string options = wardy::api::options_response(origin);
  if (!expect(options.find("HTTP/1.1 204 No Content") != std::string::npos,
              "missing OPTIONS 204 status")) return 3;

  const std::string stream = wardy::api::mjpeg_headers(origin);
  if (!expect(stream.find("multipart/x-mixed-replace; boundary=frame") != std::string::npos,
              "missing MJPEG content type") ||
      !expect(wardy::api::mjpeg_frame_header(1234).find("Content-Length: 1234") != std::string::npos,
              "wrong MJPEG content length")) return 4;
  return 0;
}
