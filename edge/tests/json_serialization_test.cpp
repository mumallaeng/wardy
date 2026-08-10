#include "api/json_serialization.hpp"

#undef NDEBUG
#include <cassert>
#include <string>

int main() {
  wardy::storage::EventRecord event;
  event.event_id = "EVT-1";
  event.event_type = "camera_fault";
  event.occurred_at = "2026-08-10T00:00:00Z";
  event.first_seen_at = event.occurred_at;
  event.last_seen_at = event.occurred_at;
  event.subject_location = "unknown";
  event.event_status = "new";
  event.reason = "camera \"fault\"\nretry";
  event.source_results_json = R"([{"source":"camera","note":"offline"}])";

  const std::string json = wardy::api::event_json(event);
  assert(json.find("\"care_status\":null") != std::string::npos);
  assert(json.find("camera \\\"fault\\\"\\nretry") != std::string::npos);
  assert(json.find("\"source_results\":[{\"source\":\"camera\"") != std::string::npos);

  const wardy::storage::SystemStateRecord state{
      "normal", "connected", "disconnected", "ready", "ready", event.occurred_at};
  const std::string state_body = wardy::api::state_json(state);
  assert(state_body.find("\"camera_state\":\"connected\"") != std::string::npos);
  return 0;
}
