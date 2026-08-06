cmake_minimum_required(VERSION 3.16)

project(wardy_edge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

find_package(SQLite3 REQUIRED)

add_library(wardy_storage STATIC
  src/storage/sqlite_store.cpp
)
target_include_directories(wardy_storage PUBLIC src)
target_link_libraries(wardy_storage PUBLIC SQLite3::SQLite3)
target_compile_options(wardy_storage PRIVATE -Wall -Wextra -Wpedantic)

add_executable(wardy_db_probe
  src/storage/database_probe.cpp
)
target_link_libraries(wardy_db_probe PRIVATE wardy_storage)
target_compile_options(wardy_db_probe PRIVATE -Wall -Wextra -Wpedantic)

add_executable(sqlite_store_test
  tests/sqlite_store_test.cpp
)
target_link_libraries(sqlite_store_test PRIVATE wardy_storage)
add_test(NAME sqlite_store_test COMMAND sqlite_store_test)

add_executable(camera_config_test
  tests/camera_config_test.cpp
)
target_include_directories(camera_config_test PRIVATE src)
add_test(NAME camera_config_test COMMAND camera_config_test)

add_executable(http_response_test
  tests/http_response_test.cpp
)
target_include_directories(http_response_test PRIVATE src)
add_test(NAME http_response_test COMMAND http_response_test)

find_package(OpenCV QUIET COMPONENTS core videoio imgcodecs)

if(OpenCV_FOUND)
  find_package(Threads REQUIRED)

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

  add_executable(wardy_edge_service
    src/api/mjpeg_service.cpp
    src/api/wardy_edge_service.cpp
  )
  target_include_directories(wardy_edge_service PRIVATE src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(wardy_edge_service PRIVATE wardy_camera wardy_storage Threads::Threads ${OpenCV_LIBS})
  target_compile_options(wardy_edge_service PRIVATE -Wall -Wextra -Wpedantic)
else()
  message(STATUS "OpenCV core/videoio/imgcodecs not found: camera library, probe, and edge service are skipped")
endif()
