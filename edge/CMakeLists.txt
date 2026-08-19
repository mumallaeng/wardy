cmake_minimum_required(VERSION 3.16)

project(wardy_edge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

add_executable(camera_config_test
  tests/camera_config_test.cpp
)
target_include_directories(camera_config_test PRIVATE src)
add_test(NAME camera_config_test COMMAND camera_config_test)

find_package(OpenCV QUIET COMPONENTS core videoio)

if(OpenCV_FOUND)
  add_library(wardy_camera STATIC
    src/input/camera_capture.cpp
  )
  target_include_directories(wardy_camera PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(wardy_camera PUBLIC ${OpenCV_LIBS})
  target_compile_options(wardy_camera PRIVATE -Wall -Wextra -Wpedantic)

  add_executable(wardy_camera_probe
    src/input/camera_probe.cpp
  )
  target_link_libraries(wardy_camera_probe PRIVATE wardy_camera)
  target_compile_options(wardy_camera_probe PRIVATE -Wall -Wextra -Wpedantic)
else()
  message(STATUS "OpenCV core/videoio not found: camera library and probe are skipped")
endif()
