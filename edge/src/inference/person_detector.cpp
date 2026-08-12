#include "inference/person_detector.hpp"

#include <NvInfer.h>
#include <cuda_runtime_api.h>

#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wardy::inference {
namespace {

class TensorRtLogger final : public nvinfer1::ILogger {
 public:
  void log(Severity severity, const char* message) noexcept override {
    if (severity <= Severity::kWARNING) {
      std::cerr << "TensorRT: " << message << '\n';
    }
  }
};

void require_cuda(cudaError_t status, const char* operation) {
  if (status != cudaSuccess) {
    throw std::runtime_error(std::string{operation} + ": " +
                             cudaGetErrorString(status));
  }
}

std::vector<char> read_engine(const std::string& path) {
  std::ifstream input(path, std::ios::binary | std::ios::ate);
  if (!input) throw std::runtime_error("unable to open M-01 TensorRT engine: " + path);
  const std::streamsize size = input.tellg();
  if (size <= 0) throw std::runtime_error("M-01 TensorRT engine is empty: " + path);
  input.seekg(0, std::ios::beg);
  std::vector<char> bytes(static_cast<std::size_t>(size));
  if (!input.read(bytes.data(), size)) {
    throw std::runtime_error("unable to read M-01 TensorRT engine: " + path);
  }
  return bytes;
}

std::size_t tensor_volume(const nvinfer1::Dims& dimensions) {
  std::size_t volume = 1;
  for (int index = 0; index < dimensions.nbDims; ++index) {
    if (dimensions.d[index] <= 0) {
      throw std::runtime_error("M-01 engine must use fixed positive tensor dimensions");
    }
    const auto extent = static_cast<std::size_t>(dimensions.d[index]);
    if (volume > std::numeric_limits<std::size_t>::max() / extent) {
      throw std::runtime_error("M-01 tensor size overflow");
    }
    volume *= extent;
  }
  return volume;
}

}  // namespace

void PersonDetectorConfig::validate() const {
  if (engine_path.empty()) throw std::invalid_argument("M-01 engine path must not be empty");
  if (!std::filesystem::is_regular_file(engine_path)) {
    throw std::invalid_argument("M-01 TensorRT engine not found: " + engine_path);
  }
  if (!std::isfinite(confidence_threshold) || confidence_threshold < 0.0F ||
      confidence_threshold > 1.0F || !std::isfinite(nms_iou_threshold) ||
      nms_iou_threshold < 0.0F || nms_iou_threshold > 1.0F) {
    throw std::invalid_argument("M-01 thresholds must be inside [0,1]");
  }
}

struct PersonDetector::Impl {
  explicit Impl(PersonDetectorConfig detector_config)
      : config(std::move(detector_config)) {
    config.validate();
    const auto engine_bytes = read_engine(config.engine_path);
    runtime.reset(nvinfer1::createInferRuntime(logger));
    if (!runtime) throw std::runtime_error("unable to create TensorRT runtime");
    engine.reset(runtime->deserializeCudaEngine(engine_bytes.data(), engine_bytes.size()));
    if (!engine) {
      throw std::runtime_error(
          "unable to deserialize M-01 engine; rebuild it on this Jetson");
    }
    context.reset(engine->createExecutionContext());
    if (!context) throw std::runtime_error("unable to create M-01 execution context");

    for (int index = 0; index < engine->getNbIOTensors(); ++index) {
      const char* name = engine->getIOTensorName(index);
      if (name == nullptr) throw std::runtime_error("M-01 engine has an unnamed tensor");
      const auto mode = engine->getTensorIOMode(name);
      if (mode == nvinfer1::TensorIOMode::kINPUT) {
        if (!input_name.empty()) throw std::runtime_error("M-01 engine must have one input");
        input_name = name;
      } else if (mode == nvinfer1::TensorIOMode::kOUTPUT) {
        if (!output_name.empty()) throw std::runtime_error("M-01 engine must have one output");
        output_name = name;
      }
    }
    if (input_name.empty() || output_name.empty()) {
      throw std::runtime_error("M-01 engine requires exactly one input and one output");
    }
    if (engine->getTensorDataType(input_name.c_str()) != nvinfer1::DataType::kFLOAT ||
        engine->getTensorDataType(output_name.c_str()) != nvinfer1::DataType::kFLOAT) {
      throw std::runtime_error("M-01 engine input and output must expose float tensors");
    }

    input_dimensions = engine->getTensorShape(input_name.c_str());
    output_dimensions = engine->getTensorShape(output_name.c_str());
    if (input_dimensions.nbDims != 4 || input_dimensions.d[0] != 1 ||
        input_dimensions.d[1] != 3 || input_dimensions.d[2] != 640 ||
        input_dimensions.d[3] != 640) {
      throw std::runtime_error("M-01 engine input must be fixed NCHW [1,3,640,640]");
    }
    if (output_dimensions.nbDims != 3 || output_dimensions.d[0] != 1) {
      throw std::runtime_error("M-01 engine output must be rank-3 YOLO11 detections");
    }
    const std::size_t input_volume = tensor_volume(input_dimensions);
    const std::size_t output_volume = tensor_volume(output_dimensions);
    const std::size_t second = static_cast<std::size_t>(output_dimensions.d[1]);
    const std::size_t third = static_cast<std::size_t>(output_dimensions.d[2]);
    if (second >= 5 && second <= 512) {
      channels_first = true;
      channel_count = second;
      candidate_count = third;
    } else if (third >= 5 && third <= 512) {
      channels_first = false;
      channel_count = third;
      candidate_count = second;
    } else {
      throw std::runtime_error("M-01 engine output is not a supported YOLO11 layout");
    }
    if (config.person_class_index >= channel_count - 4) {
      throw std::runtime_error("M-01 person class index exceeds engine class count");
    }

    input_host.resize(input_volume);
    output_host.resize(output_volume);
    try {
      require_cuda(cudaMalloc(&input_device, input_host.size() * sizeof(float)),
                   "M-01 input allocation failed");
      require_cuda(cudaMalloc(&output_device, output_host.size() * sizeof(float)),
                   "M-01 output allocation failed");
      require_cuda(cudaStreamCreate(&stream), "M-01 CUDA stream creation failed");
      if (!context->setTensorAddress(input_name.c_str(), input_device) ||
          !context->setTensorAddress(output_name.c_str(), output_device)) {
        throw std::runtime_error("unable to bind M-01 TensorRT tensors");
      }
    } catch (...) {
      if (stream != nullptr) cudaStreamDestroy(stream);
      if (output_device != nullptr) cudaFree(output_device);
      if (input_device != nullptr) cudaFree(input_device);
      stream = nullptr;
      output_device = nullptr;
      input_device = nullptr;
      throw;
    }
  }

  ~Impl() {
    if (stream != nullptr) cudaStreamDestroy(stream);
    if (output_device != nullptr) cudaFree(output_device);
    if (input_device != nullptr) cudaFree(input_device);
  }

  std::vector<PersonDetection> detect(const cv::Mat& frame_bgr) {
    if (frame_bgr.empty() || frame_bgr.type() != CV_8UC3) {
      throw std::invalid_argument("M-01 input must be a non-empty BGR8 frame");
    }

    constexpr int input_width = 640;
    constexpr int input_height = 640;
    const float scale = std::min(
        static_cast<float>(input_width) / static_cast<float>(frame_bgr.cols),
        static_cast<float>(input_height) / static_cast<float>(frame_bgr.rows));
    const int resized_width = std::max(1, static_cast<int>(std::round(frame_bgr.cols * scale)));
    const int resized_height = std::max(1, static_cast<int>(std::round(frame_bgr.rows * scale)));
    const int left = (input_width - resized_width) / 2;
    const int right = input_width - resized_width - left;
    const int top = (input_height - resized_height) / 2;
    const int bottom = input_height - resized_height - top;

    cv::Mat resized;
    cv::resize(frame_bgr, resized, {resized_width, resized_height}, 0.0, 0.0,
               cv::INTER_LINEAR);
    cv::Mat letterboxed;
    cv::copyMakeBorder(resized, letterboxed, top, bottom, left, right,
                       cv::BORDER_CONSTANT, cv::Scalar(114, 114, 114));

    const std::size_t plane = static_cast<std::size_t>(input_width * input_height);
    for (int row = 0; row < input_height; ++row) {
      const auto* pixels = letterboxed.ptr<cv::Vec3b>(row);
      for (int column = 0; column < input_width; ++column) {
        const std::size_t index = static_cast<std::size_t>(row * input_width + column);
        input_host[index] = static_cast<float>(pixels[column][2]) / 255.0F;
        input_host[plane + index] = static_cast<float>(pixels[column][1]) / 255.0F;
        input_host[2 * plane + index] = static_cast<float>(pixels[column][0]) / 255.0F;
      }
    }

    require_cuda(cudaMemcpyAsync(input_device, input_host.data(),
                                 input_host.size() * sizeof(float),
                                 cudaMemcpyHostToDevice, stream),
                 "M-01 input upload failed");
    if (!context->enqueueV3(stream)) throw std::runtime_error("M-01 inference failed");
    require_cuda(cudaMemcpyAsync(output_host.data(), output_device,
                                 output_host.size() * sizeof(float),
                                 cudaMemcpyDeviceToHost, stream),
                 "M-01 output download failed");
    require_cuda(cudaStreamSynchronize(stream), "M-01 inference synchronization failed");

    return decode_yolo11_person_output(
        output_host.data(), candidate_count, channel_count, channels_first,
        {scale, static_cast<float>(left), static_cast<float>(top),
         frame_bgr.cols, frame_bgr.rows},
        config.confidence_threshold, config.nms_iou_threshold,
        config.person_class_index);
  }

  PersonDetectorConfig config;
  TensorRtLogger logger;
  std::unique_ptr<nvinfer1::IRuntime> runtime;
  std::unique_ptr<nvinfer1::ICudaEngine> engine;
  std::unique_ptr<nvinfer1::IExecutionContext> context;
  std::string input_name;
  std::string output_name;
  nvinfer1::Dims input_dimensions{};
  nvinfer1::Dims output_dimensions{};
  bool channels_first{};
  std::size_t channel_count{};
  std::size_t candidate_count{};
  std::vector<float> input_host;
  std::vector<float> output_host;
  void* input_device{};
  void* output_device{};
  cudaStream_t stream{};
};

PersonDetector::PersonDetector(PersonDetectorConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {}

PersonDetector::~PersonDetector() = default;

std::vector<PersonDetection> PersonDetector::detect(const cv::Mat& frame_bgr) {
  return impl_->detect(frame_bgr);
}

}  // namespace wardy::inference
