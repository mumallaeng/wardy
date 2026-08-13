#ifdef NDEBUG
#undef NDEBUG
#endif

#include "llm/daily_summary.hpp"

#include <cassert>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

wardy::storage::EventRecord event(std::string care_status, std::string event_status) {
  wardy::storage::EventRecord value;
  value.event_id = "private-id";
  value.event_type = "fall_suspected";
  value.occurred_at = "2026-08-11T13:15:00Z";
  value.first_seen_at = value.occurred_at;
  value.last_seen_at = value.occurred_at;
  value.subject_id = "subject-private";
  value.subject_name = "홍길동";
  value.subject_location = "거실";
  value.object_id = "object-private";
  value.object_class = "가위";
  value.zone_id = "zone-private";
  value.care_status = std::move(care_status);
  value.event_status = std::move(event_status);
  value.reason = "private detector rationale";
  value.source_results_json = "[{\"secret\":true}]";
  value.media_type = "video";
  value.media_path = "/private/video.mp4";
  return value;
}

}  // namespace

int main() {
  const std::vector<wardy::storage::EventRecord> events = {
      event("caution", "new"), event("warning", "confirmed"),
      event("emergency", "new"),
  };

  const std::string prompt = wardy::llm::build_anonymized_prompt("2026-08-11", events);
  assert(prompt.find("총 3건") != std::string::npos);
  assert(prompt.find("고정 집계 문장(수정 금지)") != std::string::npos);
  assert(prompt.find("거실") != std::string::npos);
  assert(prompt.find("가위") != std::string::npos);
  assert(prompt.find("낙상 의심") != std::string::npos);
  assert(prompt.find("13:15") == std::string::npos);
  for (const std::string& private_value : {
           "private-id", "subject-private", "홍길동", "object-private",
           "zone-private", "private detector rationale", "secret", "video.mp4"}) {
    assert(prompt.find(private_value) == std::string::npos);
  }

  const std::string fallback = wardy::llm::deterministic_summary(events);
  assert(fallback.find("총 3건") != std::string::npos);
  assert(fallback.find("주의 1건") != std::string::npos);
  assert(fallback.find("경고 1건") != std::string::npos);
  assert(fallback.find("긴급 1건") != std::string::npos);
  assert(fallback.find("미확인 2건") != std::string::npos);

  const std::string generated =
      "오늘 총 3건의 안전 확인 이벤트가 기록되었습니다. 정상 0건, 주의 1건, "
      "경고 1건, 긴급 1건이며 미확인 2건입니다.";
  const std::string response =
      "{\"model\":\"qwen3.5:4b\",\"response\":\"{\\\"summary\\\":\\\"" +
      generated + "\\\"}\",\"done\":true}";
  assert(wardy::llm::extract_generated_summary(response) == generated);
  const std::string unicode_response =
      R"({"response":"{\"summary\":\"\uC624\uB298\"}"})";
  assert(wardy::llm::extract_generated_summary(unicode_response) == "오늘");
  const std::string surrogate_pair_response =
      R"({"response":"{\"summary\":\"\uD83D\uDEE1\uFE0F\"}"})";
  assert(wardy::llm::extract_generated_summary(surrogate_pair_response) == "🛡️");
  bool malformed_unicode_rejected = false;
  try {
    (void)wardy::llm::extract_generated_summary(
        R"({"response":"{\"summary\":\"\uD800\"}"})");
  } catch (const std::runtime_error&) {
    malformed_unicode_rejected = true;
  }
  assert(malformed_unicode_rejected);

  wardy::llm::DailySummaryConfig success_config;
  success_config.timeout = std::chrono::seconds{5};
  wardy::llm::DailySummaryService success(
      success_config, [response](const std::string&) { return response; });
  const auto success_result = success.summarize("2026-08-11", events);
  assert(!success_result.fallback);
  assert(!success_result.filtered);
  assert(success_result.summary == generated);
  assert(success_result.event_count == 3);
  assert(success_result.unconfirmed_count == 2);

  wardy::llm::DailySummaryService unavailable(
      {}, [](const std::string&) -> std::string { throw std::runtime_error("offline"); });
  const auto unavailable_result = unavailable.summarize("2026-08-11", events);
  assert(unavailable_result.fallback);
  assert(unavailable_result.fallback_reason == "unavailable");
  assert(unavailable_result.summary == fallback);

  const auto empty_result = success.summarize("2026-08-11", {});
  assert(empty_result.fallback);
  assert(empty_result.fallback_reason == "no_events");
  assert(empty_result.summary == "오늘 기록된 안전 확인 이벤트가 없습니다.");

  const std::string unsafe_suffix_response =
      "{\"response\":\"{\\\"summary\\\":\\\"" + generated +
      " 사건 발생\\\"}\"}";
  wardy::llm::DailySummaryService filtered(
      success_config, [unsafe_suffix_response](const std::string&) {
        return unsafe_suffix_response;
      });
  const auto filtered_result = filtered.summarize("2026-08-11", events);
  assert(!filtered_result.fallback);
  assert(filtered_result.filtered);
  assert(filtered_result.summary == generated);

  const std::string unverified_detail_response =
      "{\"response\":\"{\\\"summary\\\":\\\"" + generated +
      " 거실에서 안전 확인 이벤트가 관찰되었습니다.\\\"}\"}";
  wardy::llm::DailySummaryService unverified_detail(
      success_config, [unverified_detail_response](const std::string&) {
        return unverified_detail_response;
      });
  const auto unverified_detail_result = unverified_detail.summarize("2026-08-11", events);
  assert(!unverified_detail_result.fallback);
  assert(unverified_detail_result.filtered);
  assert(unverified_detail_result.summary == generated);
}
