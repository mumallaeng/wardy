#include "inference/pose_fall_client.hpp"

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cassert>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>

#include <opencv2/core.hpp>

int main() {
  const auto socket_path = std::filesystem::temp_directory_path() /
      ("wardy-pose-fall-test-" + std::to_string(getpid()) + ".sock");
  std::string captured;
  std::thread server([&] {
    const int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    assert(listener >= 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const std::string path = socket_path.string();
    std::copy(path.begin(), path.end(), address.sun_path);
    assert(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
    assert(listen(listener, 1) == 0);
    const int client = accept(listener, nullptr, nullptr);
    assert(client >= 0);
    char buffer[4096];
    while (captured.find('\n') == std::string::npos) {
      const auto count = recv(client, buffer, sizeof(buffer), 0);
      assert(count > 0);
      captured.append(buffer, static_cast<std::size_t>(count));
    }
    const std::string response =
        "{\"ok\":true,\"accepted\":true,\"fall\":{\"fall_suspected\":false,"
        "\"confidence\":0.125}}\n";
    assert(send(client, response.data(), response.size(), 0) ==
           static_cast<ssize_t>(response.size()));
    close(client);
    close(listener);
  });

  for (int retry = 0; retry < 100 && !std::filesystem::exists(socket_path); ++retry) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  wardy::inference::PoseFallClient client(socket_path.string());
  cv::Mat image(24, 32, CV_8UC3, cv::Scalar(10, 20, 30));
  wardy::inference::TrackedPersonFrame person;
  person.frame_id = "frame-1";
  person.timestamp_ms = 1234;
  person.track_id = 7;
  person.bbox_xyxy = {1.0F, 2.0F, 30.0F, 22.0F};
  const auto response = client.infer(image, person);
  server.join();
  std::filesystem::remove(socket_path);

  assert(response.ok);
  assert(response.accepted);
  assert(response.fall_suspected && !*response.fall_suspected);
  assert(response.fall_confidence && *response.fall_confidence == 0.125);
  assert(captured.find("\"frame_id\":\"frame-1\"") != std::string::npos);
  assert(captured.find("\"track_id\":7") != std::string::npos);
  assert(captured.find("\"bbox_xyxy\":[1.000000,2.000000,30.000000,22.000000]") !=
         std::string::npos);
  assert(captured.find("\"frame_jpeg_base64\":\"") != std::string::npos);

  const auto tracking_socket_path = std::filesystem::temp_directory_path() /
      ("wardy-pose-fall-tracking-test-" + std::to_string(getpid()) + ".sock");
  std::string tracking_request;
  std::thread tracking_server([&] {
    const int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    assert(listener >= 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const std::string path = tracking_socket_path.string();
    std::copy(path.begin(), path.end(), address.sun_path);
    assert(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
    assert(listen(listener, 1) == 0);
    const int connection = accept(listener, nullptr, nullptr);
    assert(connection >= 0);
    char buffer[4096];
    while (tracking_request.find('\n') == std::string::npos) {
      const auto count = recv(connection, buffer, sizeof(buffer), 0);
      assert(count > 0);
      tracking_request.append(buffer, static_cast<std::size_t>(count));
    }
    const std::string tracking_response =
        "{\"ok\":true,\"active_track_ids\":[42,2],\"persons\":["
        "{\"track_id\":42,\"accepted\":true,\"bbox_xyxy\":[2,3,20,22],"
        "\"detection_confidence\":0.95,\"history_frames\":20,\"window_frames\":20,"
        "\"fall_threshold\":0.5,\"pose\":{\"pose_quality\":0.88,"
        "\"posture\":\"standing\",\"keypoints_xyc\":["
        "[3,4,0.9],[4,5,0.9],[5,6,0.9],[6,7,0.9],[7,8,0.9],"
        "[8,9,0.9],[9,10,0.9],[10,11,0.9],[11,12,0.9],[12,13,0.9],"
        "[13,14,0.9],[14,15,0.9],[15,16,0.9],[16,17,0.9],[17,18,0.9],"
        "[18,19,0.9],[19,20,0.9]]},\"fall\":{"
        "\"fall_suspected\":true,\"confidence\":0.875}},"
        "{\"track_id\":2,\"accepted\":false,\"bbox_xyxy\":[4,5,18,20],"
        "\"detection_confidence\":0.8,\"history_frames\":4,\"window_frames\":20,"
        "\"fall_threshold\":0.5}],\"hazards\":[{\"detection_id\":\"frame-2:hazard:0\","
        "\"class_name\":\"scissors\",\"confidence\":0.91,"
        "\"bbox_xyxy\":[12,14,18,20]}]}\n";
    assert(send(connection, tracking_response.data(), tracking_response.size(), 0) ==
           static_cast<ssize_t>(tracking_response.size()));
    close(connection);
    close(listener);
  });

  for (int retry = 0;
       retry < 100 && !std::filesystem::exists(tracking_socket_path); ++retry) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  wardy::inference::PoseFallClient tracking_client(tracking_socket_path.string());
  const std::vector<wardy::inference::PersonDetection> detections{
      {{2.0F, 3.0F, 20.0F, 22.0F}, 0.95F},
  };
  const auto tracking = tracking_client.infer_frame(
      image, "frame-2", 1300, detections, true);
  tracking_server.join();
  std::filesystem::remove(tracking_socket_path);

  assert(tracking.ok);
  assert(tracking.active_track_ids.size() == 2);
  assert(tracking.persons.size() == 2);
  assert(tracking.active_track_ids[0] == 42);
  assert(tracking.persons[0].track_id == 42);
  assert(tracking.persons[0].fall_suspected &&
         *tracking.persons[0].fall_suspected);
  assert(tracking.persons[0].fall_confidence &&
         *tracking.persons[0].fall_confidence == 0.875);
  assert(tracking.persons[0].pose_quality &&
         *tracking.persons[0].pose_quality == 0.88);
  assert(tracking.persons[0].posture &&
         *tracking.persons[0].posture == "standing");
  assert(tracking.persons[0].keypoints_xyc.size() == 17);
  assert(tracking.persons[0].history_frames == 20);
  assert(tracking.persons[0].window_frames == 20);
  assert(tracking.persons[0].fall_threshold == 0.5);
  assert(tracking.persons[0].detection_confidence == 0.95F);
  assert(tracking.hazards.size() == 1);
  assert(tracking.hazards[0].class_name == "scissors");
  assert(tracking.hazards[0].confidence == 0.91);
  assert(tracking_request.find("\"person_detections\":[{") != std::string::npos);
  assert(tracking_request.find("\"confidence\":0.950000") != std::string::npos);
  assert(tracking_request.find("\"reset_tracking\":true") != std::string::npos);
  return 0;
}
