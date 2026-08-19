#include "llm/daily_summary.hpp"

#include "api/json_serialization.hpp"

#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdint>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace wardy::llm {
namespace {

constexpr std::size_t kMaximumResponseBytes = 1024 * 1024;

struct EventCounts {
  std::size_t normal = 0;
  std::size_t caution = 0;
  std::size_t warning = 0;
  std::size_t emergency = 0;
  std::size_t unconfirmed = 0;
};

EventCounts count_events(const std::vector<storage::EventRecord>& events) {
  EventCounts counts;
  for (const auto& event : events) {
    const std::string care_status = event.care_status.value_or("normal");
    if (care_status == "caution") ++counts.caution;
    else if (care_status == "warning") ++counts.warning;
    else if (care_status == "emergency") ++counts.emergency;
    else ++counts.normal;
    if (event.event_status == "new") ++counts.unconfirmed;
  }
  return counts;
}

std::string korean_care_status(const std::optional<std::string>& status) {
  if (status == "caution") return "주의";
  if (status == "warning") return "경고";
  if (status == "emergency") return "긴급";
  return "정상";
}

std::string korean_event_status(const std::string& status) {
  if (status == "confirmed") return "확인";
  if (status == "released") return "해제";
  if (status == "false_detection") return "오탐";
  return "미확인";
}

std::string korean_event_type(const std::string& type) {
  if (type == "fall_suspected") return "낙상 의심";
  if (type == "inactivity") return "장시간 정지";
  if (type == "hazard_detected") return "위험물 감지";
  if (type == "hazard_proximity") return "위험물 접근";
  if (type == "zone_entry") return "구역 진입";
  if (type == "zone_dwell") return "구역 체류";
  if (type == "camera_fault") return "카메라 연결 이상";
  if (type == "detection_fault") return "감지 기능 이상";
  return "안전 확인";
}

unsigned hex_value(char character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'a' && character <= 'f') return character - 'a' + 10;
  if (character >= 'A' && character <= 'F') return character - 'A' + 10;
  throw std::runtime_error("invalid JSON Unicode escape");
}

std::uint32_t unicode_escape(const std::string& value, std::size_t& position) {
  if (position + 4 > value.size()) throw std::runtime_error("incomplete JSON Unicode escape");
  std::uint32_t codepoint = 0;
  for (int index = 0; index < 4; ++index) {
    codepoint = codepoint * 16 + hex_value(value[position++]);
  }
  return codepoint;
}

void append_utf8(std::string& output, std::uint32_t codepoint) {
  if (codepoint <= 0x7f) output.push_back(static_cast<char>(codepoint));
  else if (codepoint <= 0x7ff) {
    output.push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
    output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
  } else if (codepoint <= 0xffff) {
    output.push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
    output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
    output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
  } else if (codepoint <= 0x10ffff) {
    output.push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
    output.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
    output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
    output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
  } else {
    throw std::runtime_error("invalid JSON Unicode codepoint");
  }
}

std::string decode_json_string_at(const std::string& value, std::size_t position,
                                  std::size_t* end_position = nullptr) {
  if (position >= value.size() || value[position] != '"') {
    throw std::runtime_error("expected JSON string");
  }
  std::string decoded;
  for (++position; position < value.size(); ++position) {
    const char character = value[position];
    if (character == '"') {
      if (end_position) *end_position = position + 1;
      return decoded;
    }
    if (character != '\\') {
      decoded.push_back(character);
      continue;
    }
    if (++position >= value.size()) throw std::runtime_error("incomplete JSON escape");
    const char escaped = value[position];
    switch (escaped) {
      case '"': decoded.push_back('"'); break;
      case '\\': decoded.push_back('\\'); break;
      case '/': decoded.push_back('/'); break;
      case 'b': decoded.push_back('\b'); break;
      case 'f': decoded.push_back('\f'); break;
      case 'n': decoded.push_back('\n'); break;
      case 'r': decoded.push_back('\r'); break;
      case 't': decoded.push_back('\t'); break;
      case 'u': {
        ++position;
        std::uint32_t codepoint = unicode_escape(value, position);
        if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
          if (position + 2 > value.size() || value[position] != '\\' ||
              value[position + 1] != 'u') {
            throw std::runtime_error("missing JSON low surrogate");
          }
          position += 2;
          const std::uint32_t low = unicode_escape(value, position);
          if (low < 0xdc00 || low > 0xdfff) {
            throw std::runtime_error("invalid JSON low surrogate");
          }
          codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (low - 0xdc00);
        } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) {
          throw std::runtime_error("unexpected JSON low surrogate");
        }
        append_utf8(decoded, codepoint);
        --position;
        break;
      }
      default: throw std::runtime_error("unsupported JSON escape");
    }
  }
  throw std::runtime_error("unterminated JSON string");
}

void skip_whitespace(const std::string& json, std::size_t& position) {
  while (position < json.size() &&
         (json[position] == ' ' || json[position] == '\n' ||
          json[position] == '\r' || json[position] == '\t')) ++position;
}

void skip_json_value(const std::string& json, std::size_t& position) {
  skip_whitespace(json, position);
  if (position >= json.size()) throw std::runtime_error("JSON value is missing");
  if (json[position] == '"') {
    (void)decode_json_string_at(json, position, &position);
    return;
  }
  if (json[position] == '{' || json[position] == '[') {
    const char open = json[position++];
    const char close = open == '{' ? '}' : ']';
    while (position < json.size()) {
      skip_whitespace(json, position);
      if (position < json.size() && json[position] == close) { ++position; return; }
      if (open == '{') {
        (void)decode_json_string_at(json, position, &position);
        skip_whitespace(json, position);
        if (position >= json.size() || json[position++] != ':') {
          throw std::runtime_error("JSON object is malformed");
        }
      }
      skip_json_value(json, position);
      skip_whitespace(json, position);
      if (position < json.size() && json[position] == ',') { ++position; continue; }
      if (position < json.size() && json[position] == close) { ++position; return; }
      throw std::runtime_error("JSON collection is malformed");
    }
    throw std::runtime_error("unterminated JSON collection");
  }
  while (position < json.size() && json[position] != ',' &&
         json[position] != '}' && json[position] != ']') ++position;
}

std::string string_property(const std::string& json, const std::string& name) {
  std::size_t position = 0;
  skip_whitespace(json, position);
  if (position >= json.size() || json[position++] != '{') {
    throw std::runtime_error("expected JSON object");
  }
  while (position < json.size()) {
    skip_whitespace(json, position);
    if (position < json.size() && json[position] == '}') break;
    const std::string key = decode_json_string_at(json, position, &position);
    skip_whitespace(json, position);
    if (position >= json.size() || json[position++] != ':') {
      throw std::runtime_error("JSON property is malformed");
    }
    skip_whitespace(json, position);
    if (key == name) {
      if (position >= json.size() || json[position] != '"') {
        throw std::runtime_error("JSON string value is missing");
      }
      return decode_json_string_at(json, position);
    }
    skip_json_value(json, position);
    skip_whitespace(json, position);
    if (position < json.size() && json[position] == ',') { ++position; continue; }
    if (position < json.size() && json[position] == '}') break;
    throw std::runtime_error("JSON object is malformed");
  }
  throw std::runtime_error("JSON property is missing");
}

std::string decode_chunked_body(const std::string& body) {
  std::string decoded;
  std::size_t position = 0;
  while (position < body.size()) {
    const std::size_t line_end = body.find("\r\n", position);
    if (line_end == std::string::npos) throw std::runtime_error("invalid chunked response");
    std::size_t parsed = 0;
    const std::size_t size = std::stoul(body.substr(position, line_end - position), &parsed, 16);
    if (parsed == 0) throw std::runtime_error("invalid chunk length");
    position = line_end + 2;
    if (size == 0) return decoded;
    if (position + size + 2 > body.size()) throw std::runtime_error("incomplete chunked response");
    decoded.append(body, position, size);
    position += size;
    if (body.substr(position, 2) != "\r\n") throw std::runtime_error("invalid chunk separator");
    position += 2;
  }
  throw std::runtime_error("missing final chunk");
}

std::string post_to_ollama(int port, std::chrono::seconds timeout,
                           const std::string& request_body) {
  const int socket_fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd < 0) throw std::runtime_error("cannot create Ollama socket");
  const timeval socket_timeout{static_cast<long>(timeout.count()), 0};
  if (::setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &socket_timeout,
                   sizeof(socket_timeout)) < 0 ||
      ::setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &socket_timeout,
                   sizeof(socket_timeout)) < 0) {
    ::close(socket_fd);
    throw std::runtime_error("cannot configure Ollama timeout");
  }

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(static_cast<std::uint16_t>(port));
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (::connect(socket_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
    ::close(socket_fd);
    throw std::runtime_error("Ollama is unavailable");
  }

  const std::string request =
      "POST /api/generate HTTP/1.1\r\nHost: 127.0.0.1\r\n"
      "Content-Type: application/json\r\nAccept: application/json\r\n"
      "Connection: close\r\nContent-Length: " + std::to_string(request_body.size()) +
      "\r\n\r\n" + request_body;
  std::size_t sent = 0;
  while (sent < request.size()) {
    const ssize_t count = ::send(socket_fd, request.data() + sent,
                                 request.size() - sent, MSG_NOSIGNAL);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      ::close(socket_fd);
      throw std::runtime_error("Ollama request failed");
    }
    sent += static_cast<std::size_t>(count);
  }

  std::string response;
  std::array<char, 8192> buffer{};
  for (;;) {
    const ssize_t count = ::recv(socket_fd, buffer.data(), buffer.size(), 0);
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      ::close(socket_fd);
      throw std::runtime_error(errno == EAGAIN || errno == EWOULDBLOCK
                                   ? "Ollama request timed out" : "Ollama response failed");
    }
    response.append(buffer.data(), static_cast<std::size_t>(count));
    if (response.size() > kMaximumResponseBytes) {
      ::close(socket_fd);
      throw std::runtime_error("Ollama response is too large");
    }
  }
  ::close(socket_fd);

  const std::size_t header_end = response.find("\r\n\r\n");
  if (header_end == std::string::npos || response.rfind("HTTP/1.1 200", 0) != 0) {
    throw std::runtime_error("Ollama returned an error");
  }
  std::string body = response.substr(header_end + 4);
  const std::string headers = response.substr(0, header_end);
  if (headers.find("Transfer-Encoding: chunked") != std::string::npos ||
      headers.find("transfer-encoding: chunked") != std::string::npos) {
    body = decode_chunked_body(body);
  }
  return body;
}

std::string request_body(const DailySummaryConfig& config, const std::string& prompt) {
  const std::string system =
      "당신은 Wardy 가정 안전 기록의 한국어 문장 편집기다. 프롬프트의 고정 집계 "
      "문장을 한 글자도 바꾸지 않고 summary의 첫 문장으로 복사하라. 둘째 문장은 "
      "제공된 한국어 이벤트명과 위치만 사용해 관찰되었다는 표현으로 정리할 수 있다. "
      "의료 진단, 사고나 사건의 발생 및 확정, 위험 추측, 행동 지시, 시간, 이름, "
      "식별자, 사진, 영상은 절대 추가하지 마라.";
  return "{\"model\":" + api::json_string(config.model) +
      ",\"system\":" + api::json_string(system) +
      ",\"prompt\":" + api::json_string(prompt) +
      ",\"stream\":false,\"think\":false,\"keep_alive\":\"0s\","
      "\"format\":{\"type\":\"object\",\"properties\":{\"summary\":{\"type\":\"string\"}},"
      "\"required\":[\"summary\"]},"
      "\"options\":{\"num_ctx\":2048,\"num_predict\":100,\"temperature\":0,\"seed\":7}}";
}

}  // namespace

void DailySummaryConfig::validate() const {
  if (model.empty()) throw std::invalid_argument("LLM model must not be empty");
  if (model.find_first_of("\r\n") != std::string::npos) {
    throw std::invalid_argument("LLM model must be a single line");
  }
  if (ollama_port < 1 || ollama_port > 65535) {
    throw std::invalid_argument("Ollama port must be between 1 and 65535");
  }
  if (timeout < std::chrono::seconds{1} || timeout > std::chrono::seconds{120}) {
    throw std::invalid_argument("LLM timeout must be between 1 and 120 seconds");
  }
}

std::string deterministic_summary(const std::vector<storage::EventRecord>& events) {
  if (events.empty()) return "오늘 기록된 안전 확인 이벤트가 없습니다.";
  const auto counts = count_events(events);
  return "오늘 총 " + std::to_string(events.size()) +
      "건의 안전 확인 이벤트가 기록되었습니다. 정상 " + std::to_string(counts.normal) +
      "건, 주의 " + std::to_string(counts.caution) + "건, 경고 " +
      std::to_string(counts.warning) + "건, 긴급 " +
      std::to_string(counts.emergency) + "건이며 미확인 " +
      std::to_string(counts.unconfirmed) + "건입니다.";
}

std::string build_anonymized_prompt(
    const std::string& date, const std::vector<storage::EventRecord>& events) {
  std::ostringstream prompt;
  prompt << "날짜: " << date << '\n'
         << "고정 집계 문장(수정 금지): " << deterministic_summary(events)
         << "\n관찰 기록:\n";
  for (const auto& event : events) {
    prompt << "- 이벤트 " << korean_event_type(event.event_type)
           << " | 상태 " << korean_care_status(event.care_status)
           << " | 처리 " << korean_event_status(event.event_status)
           << " | 위치 " << event.subject_location;
    if (event.object_class && !event.object_class->empty()) {
      prompt << " | 관찰 물체 " << *event.object_class;
    }
    prompt << '\n';
  }
  return prompt.str();
}

std::string extract_generated_summary(const std::string& ollama_response) {
  const std::string generated_json = string_property(ollama_response, "response");
  return string_property(generated_json, "summary");
}

DailySummaryService::DailySummaryService(DailySummaryConfig config,
                                         GenerateRequest generate_request)
    : config_(std::move(config)), generate_request_(std::move(generate_request)) {
  config_.validate();
  if (!generate_request_) {
    generate_request_ = [config = config_](const std::string& prompt) {
      return post_to_ollama(config.ollama_port, config.timeout, request_body(config, prompt));
    };
  }
}

DailySummaryResult DailySummaryService::summarize(
    const std::string& date, const std::vector<storage::EventRecord>& events) const {
  DailySummaryResult result;
  result.model = config_.model;
  result.event_count = events.size();
  result.unconfirmed_count = count_events(events).unconfirmed;
  const std::string fallback = deterministic_summary(events);
  if (events.empty()) {
    result.summary = fallback;
    result.fallback = true;
    result.fallback_reason = "no_events";
    return result;
  }
  if (!config_.enabled) {
    result.summary = fallback;
    result.fallback = true;
    result.fallback_reason = "disabled";
    return result;
  }

  const auto started = std::chrono::steady_clock::now();
  try {
    const std::string response = generate_request_(build_anonymized_prompt(date, events));
    const std::string generated = extract_generated_summary(response);
    if (generated.rfind(fallback, 0) == 0) {
      result.summary = fallback;
      result.filtered = generated != fallback;
    } else {
      result.summary = fallback;
      result.fallback = true;
      result.fallback_reason = "invalid_output";
    }
  } catch (const std::exception&) {
    result.summary = fallback;
    result.fallback = true;
    result.fallback_reason = "unavailable";
  }
  result.duration_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  return result;
}

}  // namespace wardy::llm
