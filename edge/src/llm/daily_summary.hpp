#pragma once

#include <chrono>
#include <functional>
#include <string>
#include <vector>

#include "storage/sqlite_store.hpp"

namespace wardy::llm {

struct DailySummaryConfig {
  bool enabled = true;
  std::string model = "qwen3.5:4b";
  int ollama_port = 11434;
  std::chrono::seconds timeout{30};

  void validate() const;
};

struct DailySummaryResult {
  std::string summary;
  std::string model;
  bool fallback = false;
  bool filtered = false;
  std::string fallback_reason;
  std::size_t event_count = 0;
  std::size_t unconfirmed_count = 0;
  long duration_ms = 0;
};

using GenerateRequest = std::function<std::string(const std::string&)>;

std::string build_anonymized_prompt(
    const std::string& date, const std::vector<storage::EventRecord>& events);
std::string deterministic_summary(const std::vector<storage::EventRecord>& events);
std::string extract_generated_summary(const std::string& ollama_response);
class DailySummaryService {
 public:
  explicit DailySummaryService(DailySummaryConfig config,
                               GenerateRequest generate_request = {});

  DailySummaryResult summarize(
      const std::string& date, const std::vector<storage::EventRecord>& events) const;

 private:
  DailySummaryConfig config_;
  GenerateRequest generate_request_;
};

}  // namespace wardy::llm
