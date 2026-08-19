#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace wardy::api {

inline bool protected_api_path(const std::string& path) {
  return path.rfind("/api/", 0) == 0 && path != "/api/health" && path != "/api/ws";
}

inline bool access_token_authorized(const std::string& request,
                                    const std::string& access_token) {
  std::string lowered = request;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(),
                 [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
  const std::string header = "\r\nx-wardy-access-token:";
  const std::size_t start = lowered.find(header);
  if (start == std::string::npos) return false;
  std::size_t value_start = start + header.size();
  while (value_start < request.size() &&
         (request[value_start] == ' ' || request[value_start] == '\t')) ++value_start;
  const std::size_t end = request.find("\r\n", value_start);
  return end != std::string::npos && request.substr(value_start, end - value_start) == access_token;
}

}  // namespace wardy::api
