cmake_minimum_required(VERSION 3.16)

project(wardy_edge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

find_package(SQLite3 REQUIRED)
find_package(Threads REQUIRED)

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

add_library(wardy_llm STATIC
  src/llm/daily_summary.cpp
)
target_include_directories(wardy_llm PUBLIC src)
target_link_libraries(wardy_llm PUBLIC wardy_storage)
target_compile_options(wardy_llm PRIVATE -Wall -Wextra -Wpedantic)

add_executable(daily_summary_test
  tests/daily_summary_test.cpp
)
target_link_libraries(daily_summary_test PRIVATE wardy_llm)
add_test(NAME daily_summary_test COMMAND daily_summary_test)

add_library(wardy_event_runtime STATIC
  src/rules/event_runtime.cpp
)
target_include_directories(wardy_event_runtime PUBLIC src)
target_link_libraries(wardy_event_runtime PUBLIC wardy_storage Threads::Threads)
target_compile_options(wardy_event_runtime PRIVATE -Wall -Wextra -Wpedantic)

add_executable(event_runtime_test
  tests/event_runtime_test.cpp
)
target_link_libraries(event_runtime_test PRIVATE wardy_event_runtime)
add_test(NAME event_runtime_test COMMAND event_runtime_test)

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

add_executable(request_security_test
  tests/request_security_test.cpp
)
target_include_directories(request_security_test PRIVATE src)
add_test(NAME request_security_test COMMAND request_security_test)

add_executable(json_serialization_test
  tests/json_serialization_test.cpp
)
target_include_directories(json_serialization_test PRIVATE src)
target_link_libraries(json_serialization_test PRIVATE wardy_storage)
add_test(NAME json_serialization_test COMMAND json_serialization_test)

add_executable(websocket_test
  tests/websocket_test.cpp
)
target_include_directories(websocket_test PRIVATE src)
add_test(NAME websocket_test COMMAND websocket_test)

add_library(wardy_person_detector_postprocess STATIC
  src/inference/person_detector_postprocess.cpp
)
target_include_directories(wardy_person_detector_postprocess PUBLIC src)
target_compile_options(wardy_person_detector_postprocess PRIVATE -Wall -Wextra -Wpedantic)

add_executable(person_detector_postprocess_test
  tests/person_detector_postprocess_test.cpp
)
target_link_libraries(person_detector_postprocess_test PRIVATE wardy_person_detector_postprocess)
add_test(NAME person_detector_postprocess_test COMMAND person_detector_postprocess_test)

find_package(OpenCV QUIET COMPONENTS core videoio imgcodecs imgproc)

if(OpenCV_FOUND)
  add_library(wardy_pose_fall_client STATIC
    src/inference/pose_fall_client.cpp
  )
  target_include_directories(wardy_pose_fall_client PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(wardy_pose_fall_client PUBLIC ${OpenCV_LIBS})
  target_compile_options(wardy_pose_fall_client PRIVATE -Wall -Wextra -Wpedantic)

  add_executable(pose_fall_client_test
    tests/pose_fall_client_test.cpp
  )
  target_link_libraries(pose_fall_client_test PRIVATE wardy_pose_fall_client Threads::Threads)
  add_test(NAME pose_fall_client_test COMMAND pose_fall_client_test)

  add_executable(wardy_pose_fall_probe
    src/inference/pose_fall_probe.cpp
  )
  target_link_libraries(wardy_pose_fall_probe PRIVATE wardy_pose_fall_client)
  target_compile_options(wardy_pose_fall_probe PRIVATE -Wall -Wextra -Wpedantic)

  add_library(wardy_camera STATIC
    src/input/camera_capture.cpp
  )
  target_include_directories(wardy_camera PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(wardy_camera PUBLIC ${OpenCV_LIBS})
  target_compile_options(wardy_camera PRIVATE -Wall -Wextra -Wpedantic)

  find_path(TENSORRT_INCLUDE_DIR NvInfer.h
    HINTS /usr/include/aarch64-linux-gnu /usr/include)
  find_library(TENSORRT_LIBRARY nvinfer
    HINTS /usr/lib/aarch64-linux-gnu /usr/lib)
  find_path(CUDART_INCLUDE_DIR cuda_runtime_api.h
    HINTS /usr/local/cuda/include)
  find_library(CUDART_LIBRARY cudart
    HINTS /usr/local/cuda/lib64 /usr/lib/aarch64-linux-gnu)

  if(TENSORRT_INCLUDE_DIR AND TENSORRT_LIBRARY AND CUDART_INCLUDE_DIR AND CUDART_LIBRARY)
    add_library(wardy_person_inference STATIC
      src/inference/person_detector.cpp
      src/inference/person_inference_runtime.cpp
    )
    target_include_directories(wardy_person_inference PUBLIC
      src ${OpenCV_INCLUDE_DIRS} ${TENSORRT_INCLUDE_DIR} ${CUDART_INCLUDE_DIR})
    target_link_libraries(wardy_person_inference PUBLIC
      wardy_person_detector_postprocess ${OpenCV_LIBS}
      ${TENSORRT_LIBRARY} ${CUDART_LIBRARY} Threads::Threads)
    target_compile_options(wardy_person_inference PRIVATE -Wall -Wextra -Wpedantic)
  else()
    message(STATUS "TensorRT/CUDA development files not found: M-01 Jetson inference is disabled")
  endif()

  add_library(wardy_event_media STATIC
    src/media/event_media.cpp
  )
  target_include_directories(wardy_event_media PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(wardy_event_media PUBLIC wardy_storage ${OpenCV_LIBS} Threads::Threads)
  target_compile_options(wardy_event_media PRIVATE -Wall -Wextra -Wpedantic)

  add_executable(event_media_test
    tests/event_media_test.cpp
  )
  target_link_libraries(event_media_test PRIVATE wardy_event_media)
  add_test(NAME event_media_test COMMAND event_media_test)

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
  target_link_libraries(wardy_edge_service PRIVATE wardy_camera wardy_event_runtime wardy_event_media wardy_llm Threads::Threads ${OpenCV_LIBS})
  if(TARGET wardy_person_inference)
    target_link_libraries(wardy_edge_service PRIVATE wardy_person_inference)
    target_compile_definitions(wardy_edge_service PRIVATE WARDY_WITH_TENSORRT=1)
  endif()
  target_compile_options(wardy_edge_service PRIVATE -Wall -Wextra -Wpedantic)
else()
  message(STATUS "OpenCV core/videoio/imgcodecs not found: camera library, probe, and edge service are skipped")
endif()
