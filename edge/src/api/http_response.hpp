#pragma once

#include <cstddef>
#include <string>

namespace wardy::api {

inline std::string common_headers() {
  return "Access-Control-Allow-Origin: *\r\n"
         "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
         "Access-Control-Allow-Headers: Accept, Content-Type, X-Wardy-Item-Id, X-Wardy-Item-Label, X-Wardy-Item-Policy\r\n"
         "Cache-Control: no-store\r\n";
}

inline std::string json_response(int status, const std::string& reason,
                                 const std::string& body) {
  return "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n" +
         common_headers() + "Content-Type: application/json; charset=utf-8\r\n" +
         "Content-Length: " + std::to_string(body.size()) + "\r\n"
         "Connection: close\r\n\r\n" + body;
}

inline std::string health_response(bool camera_connected) {
  const std::string body =
      std::string{"{\"service\":\"wardy-edge\",\"version\":\"0.1.0\",\"camera\":\""} +
      (camera_connected ? "connected" : "fault") + "\"}";
  return json_response(200, "OK", body);
}

inline std::string options_response() {
  return "HTTP/1.1 204 No Content\r\n" + common_headers() +
         "Content-Length: 0\r\nConnection: close\r\n\r\n";
}

inline std::string mjpeg_headers() {
  return "HTTP/1.1 200 OK\r\n" + common_headers() +
         "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
         "Connection: close\r\n\r\n";
}

inline std::string mjpeg_frame_header(std::size_t size) {
  return "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
         std::to_string(size) + "\r\n\r\n";
}

}  // namespace wardy::api
