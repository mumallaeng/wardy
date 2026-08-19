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
  return 0;
}
