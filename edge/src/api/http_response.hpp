#pragma once

#include <cstddef>
#include <string>

namespace wardy::api {

inline std::string common_headers(const std::string& allowed_origin) {
  return "Access-Control-Allow-Origin: " + allowed_origin + "\r\n"
         "Vary: Origin\r\n"
         "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n"
         "Access-Control-Allow-Headers: Accept, Content-Type, X-Wardy-Access-Token, X-Wardy-Summary-Date, X-Wardy-Item-Id, X-Wardy-Item-Label, X-Wardy-Item-Policy, X-Wardy-Subject-Id, X-Wardy-Subject-Name, X-Wardy-Subject-Role, X-Wardy-Event-Type, X-Wardy-Event-Active, X-Wardy-Observed-At, X-Wardy-Subject-Location, X-Wardy-Object-Id, X-Wardy-Object-Class, X-Wardy-Zone-Id, X-Wardy-Reason, X-Wardy-Model-Id, X-Wardy-Requirement-Id, X-Wardy-Label, X-Wardy-Capture-Session, X-Wardy-Review-Status, X-Wardy-Original-Filename, X-Wardy-Identity-Review-Enabled, X-Wardy-Event-Media-Enabled, X-Wardy-Model-Improvement-Enabled, X-Wardy-Event-Media-Retention-Days, X-Wardy-Training-Data-Retention-Days, X-Wardy-Consent-Version\r\n"
         "Cache-Control: no-store\r\n";
}

inline std::string json_response(int status, const std::string& reason,
                                 const std::string& body,
                                 const std::string& allowed_origin) {
  return "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n" +
         common_headers(allowed_origin) + "Content-Type: application/json; charset=utf-8\r\n" +
         "Content-Length: " + std::to_string(body.size()) + "\r\n"
         "Connection: close\r\n\r\n" + body;
}

inline std::string health_response(bool camera_connected, const std::string& allowed_origin) {
  const std::string body =
      std::string{"{\"service\":\"wardy-edge\",\"version\":\"0.1.0\",\"camera\":\""} +
      (camera_connected ? "connected" : "fault") + "\"}";
  return json_response(200, "OK", body, allowed_origin);
}

inline std::string options_response(const std::string& allowed_origin) {
  return "HTTP/1.1 204 No Content\r\n" + common_headers(allowed_origin) +
         "Content-Length: 0\r\nConnection: close\r\n\r\n";
}

inline std::string mjpeg_headers(const std::string& allowed_origin) {
  return "HTTP/1.1 200 OK\r\n" + common_headers(allowed_origin) +
         "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
         "Connection: close\r\n\r\n";
}

inline std::string mjpeg_frame_header(std::size_t size) {
  return "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
         std::to_string(size) + "\r\n\r\n";
}

}  // namespace wardy::api
