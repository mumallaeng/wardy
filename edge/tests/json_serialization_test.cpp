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

  event.source_results_json = R"([malformed])";
  assert(wardy::api::event_json(event).find("\"source_results\":[]") != std::string::npos);
  event.source_results_json = R"([{"source":"camera","nested":[true,null,1.5e2]}])";
  assert(wardy::api::event_json(event).find("\"nested\":[true,null,1.5e2]") != std::string::npos);

  const wardy::storage::SystemStateRecord state{
      "normal", "connected", "disconnected", "ready", "ready", event.occurred_at};
  const std::string state_body = wardy::api::state_json(state);
  assert(state_body.find("\"camera_state\":\"connected\"") != std::string::npos);
  const std::string snapshot = wardy::api::runtime_snapshot_json(state, {event});
  assert(snapshot.find("\"events\":[{") != std::string::npos);

  const wardy::storage::DatasetSampleRecord sample{
      "dataset-sample-001", "M-03-04", "DS-002", "standing", "approved",
      "session-0811-pm", "local_file", "datasets/sample-001.png", "pose.png",
      "2026-08-11T05:00:00Z", 640, 480};
  const std::string samples = wardy::api::dataset_samples_json({sample});
  assert(samples.find("\"reviewStatus\":\"approved\"") != std::string::npos);
  assert(samples.find("\"originalFilename\":\"pose.png\"") != std::string::npos);
  return 0;
}
