#include "api/http_response.hpp"

#include <cassert>
#include <string>

int main() {
  const std::string health = wardy::api::health_response(true);
  assert(health.find("HTTP/1.1 200 OK") != std::string::npos);
  assert(health.find("Access-Control-Allow-Origin: *") != std::string::npos);
  assert(health.find("\"camera\":\"connected\"") != std::string::npos);

  const std::string stream = wardy::api::mjpeg_headers();
  assert(stream.find("multipart/x-mixed-replace; boundary=frame") != std::string::npos);
  assert(wardy::api::mjpeg_frame_header(1234).find("Content-Length: 1234") != std::string::npos);
  return 0;
}
