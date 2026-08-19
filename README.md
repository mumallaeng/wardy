English | [한국어](README.ko.md)

# Wardy — Home Care Safety Monitoring On-Device AI Platform

Group 9: Kim Yeonwoo (Fall Detection & Integration), Park Ji-won (Hazard Detection), Jung Joong-min (Person Detection)

2026.08.05~2026.08.19

| <img height="350" alt="핸드폰에서도_가능-3배속" src="https://github.com/user-attachments/assets/b12f03c7-5a77-4232-b4c0-9c78a0ab49fb" /> | <img height="350" alt="0817-13 19 31-눕기낙상구분" src="https://github.com/user-attachments/assets/b5107d28-c2b3-41f3-99fb-172386db3e4d" /> |
|:---:|:---:|

## 1. Overview

### 1.1 Purpose and Goals

The purpose of this project is to implement Wardy, a home on-device AI safety monitoring platform that automatically detects critical situations requiring verification—such as falls, prolonged immobility, and proximity to hazards—during caregiver absence or brief breaks away from the care recipient using only a USB camera and an edge device. It then organizes these situations into incidents and evidence materials for display to the caregiver.

The ultimate goal is to integrate six AI modules (M-01~M-06)—person detection, anonymous tracking, pose estimation, temporal fall detection, hazard detection, and daily summaries—into a single Jetson Edge pipeline, enabling real-time verification of video, events, and care status via a browser UI. Completing inference and storage entirely on the edge device without transmitting video to the cloud is also included as a core objective.

### 1.2 Design Scope

The design scope includes the pipeline structure of the C++ Edge Service and Python Inference Runtime operating on the Jetson Orin Nano, the six AI modules (M-01 Person Detection, M-02 Anonymous Tracking, M-03 Pose Estimation, M-04 Temporal Fall Detection, M-05 Hazard Detection, and M-06 Local LLM-based Daily Summary), event and care status contracts with SQLite storage, and browser UI integration based on HTTPS and WebRTC.

Full stability verification for multi-camera integration, external notification integration, cloud-based remote access, and long-term unmanned operation is excluded from this deliverable's scope. These items were explicitly designated as future improvement directions in the final presentation.

### 1.3 Project Summary

Wardy originated from the question of "Who and how to verify risks occurring repeatedly during 'care gaps' when caregivers leave their posts in ordinary homes." Since standard CCTV only displays video, leaving the judgment, recording, and verification of critical situations to the caregiver, falls are easily missed due to their brevity and rapid posture changes, and determining whether hazardous objects like scissors or knives are being used via video alone remains difficult. Based on this problem awareness, a system was designed using USB cameras and edge devices to detect the safety status of care recipients and organize it into incidents and evidence materials verifiable by caregivers.

The final pipeline structure involves the C++ Edge Service receiving camera frames and executing TensorRT-based M-01 Person Detection; results are passed via Unix domain socket to Python pose_fall_worker, which executes M-02 Anonymous Tracking (assigning track_id), followed sequentially by M-03 Pose Estimation and M-04 Temporal Fall Detection. Separately within the same C++ Edge Service, M-05 Hazard Detection runs, comparing person locations with hazard locations to generate proximity events. Accumulated events over a day are summarized by M-06 using a local LLM and delivered to the user. Key keywords include on-device inference, anonymous track_id-based tracking, temporal pose-sequence-based fall judgment, hazard proximity events, and local LLM daily summaries.

### 1.4 Design Specification Summary
| Item | Content |
|---|---|
| Edge Device | NVIDIA Jetson Orin Nano (aarch64), Ubuntu 22.04.5 LTS, JetPack 6.2.2 |
| Video Input | USB Webcam (e.g., Logitech C270), V4L2, GStreamer |
| M-01 Person Detection | YOLO11n, TensorRT inference, single person class |
| M-02 Person Tracking | Kalman Filter + IoU Gate + Hungarian Matching (SORT family), anonymous track_id |
| M-03 Pose Estimation | OpenMMLab RTMPose-M, COCO-17 keypoints, geometry-rule-based pose classification |
| M-04 Fall Detection | TemporalFallGRU (unidirectional GRU) + standing→lying Fast Path rule |
| M-05 Hazard Detection | YOLO11n, Scissors/Knife/Cutter/Syringe 4 classes |
| M-06 Daily Summary | Ollama-based local LLM, Qwen3.5:4b, JSON Schema validation + Deterministic Fallback |
| Storage & Communication | SQLite event storage, HTTPS API·WebSocket·WebRTC(WHEP), Caddy gateway |
| Web UI | Vite, TypeScript, browser UI based on HTML/CSS |

### 1.5 AS-IS / TO-BE

| Category | AS-IS (Limitations of the existing approach) | TO-BE (Wardy) |
|---|---|---|
| Verification Method | Standard CCTV provides only video; guardians must personally judge, record, and verify hazardous situations | On-device AI automatically detects hazardous situations and presents them as incidents and evidence |
| Real-time Capability | Situations occurring in short bursts, such as falls, are easily missed if the guardian does not continuously monitor in real time | M-01~M-04 chain-process person detection→tracking→pose→temporal fall judgment in real time to immediately generate suspected fall events |
| Operation & Wear Burden | Wearable and emergency button methods allow immediate calling but require wearing and operation | Camera-based monitoring enables continuous surveillance without additional wearing or operation |
| Privacy & Latency | Cloud AI cameras enable automatic analysis but incur network latency and privacy transmission burdens | Video inference and LLM summarization are completed internally on the edge device, preventing external transmission of video and records |
| Hazard Judgment | Judgments regarding hazardous object usage (e.g., scissors, knives) depend on guardian video verification | M-05 detects hazards in real time and distinguishes between warning and alert stages based on proximity to persons, recording as events |

CDC and WHO statistics on elderly falls indicate that approximately one out of four adults over 65 experiences a fall annually, with the risk of death or serious injury from falls increasing with age. Research on fall risk factors in dementia patients concludes that dementia patients fall more frequently than cognitively healthy elderly individuals, with balance, gait, vision, functional status, medication, and dementia severity acting as complexly related factors. These statistics serve as background justification supporting the necessity of automatically verifying hazardous situations during care gaps.

## 2. Project Management (Project Management)

### 2.1 Schedule Planning (Schedule)

| Phase | Duration | Key Tasks |
|---|---|---|
| Requirements Consolidation | 08-05 | Confirm P0 scope and role division, consolidate M-01~M-06 functional requirements, organize deliverable structure |
| Design & Specification | 08-05~08-09 | System architecture design, investigate M-05/M-01 dataset candidates, design AI evaluation/demonstration scenarios (S-01~S-07) |
| Implementation | 08-07~08-13 | M-05 fine-tuning and filter implementation for management items, merge and train M-01 dataset, implement M-02~M-04 models and edge integration |
| Verification | 08-10~08-14 | Compare M-05 model versions, verify M-01 TensorRT export, conduct integrated verification of M-02~M-04 (threshold/latch stabilization), secure demonstration evidence for M-05 edge integration, incorporate M-01 review feedback |
| Presentation & Deliverable Consolidation | 08-13~08-19 | Implement M-06 and integrate the entire system, compile completion report and presentation materials, organize module-specific presentation materials |
| Final Submission | 08-19 | Verify normality of PPTX·DOCX·XLSX·source code ZIP files |

From August 13 to August 18, the period extended into integrated verification, sequentially identifying and correcting recognition and state processing issues actually occurring within the integrated pipeline beyond individual model implementation; detailed content is discussed in Chapter 5.

### 2.2 Development Environment (Development Environment)

**Jetson (Edge Device, Inference·Storage·API Server)**
| Item | Development Environment and Settings |
|---|---|
| Hardware · Architecture | NVIDIA Jetson Orin Nano · aarch64 |
| Operating System · Kernel | Ubuntu 22.04.5 LTS · JetPack SDK 6.2.2 · Jetson Linux/L4T R36.5.0 · Linux 5.15.185-tegra |
| GPU Inference Environment | CUDA Toolkit 12.6.11 · cuDNN 9.3.0.75 · TensorRT 10.3.0 |
| C++ Build Environment | CMake 4.4.2 · GCC/G++ 11.4.0 · pkg-config 0.29.2 |
| C++ Runtime Library | OpenCV 4.8.0 · SQLite 3.37.2 |
| Python Inference Environment | Python 3.10.12 · NumPy 1.26.4 · ONNX Runtime 1.23.2 · SciPy 1.15.3 · Python OpenCV 4.5.4 |
| Camera · Video Environment | V4L2 utilities 1.22.1 · GStreamer 1.20.3 |
| Gateway · Media Server | Caddy 2.11.3 · MediaMTX 1.18.2 |
| Local LLM Environment | Ollama 0.32.5 · Qwen qwen3.5:4b |
| System · Security Tools | systemd 249 · OpenSSL 3.0.2 · curl 7.81.0 · Git 2.34.1 |
| Responsible Roles | USB Webcam input, on-device AI inference, object tracking · posture · fall analysis, event handling, SQLite storage, local LLM execution, HTTPS API · WebRTC provision |
| Start Method | ./start_jetson.sh — On first execution, installs dependencies, models, TensorRT engines, TLS certificates, and systemd services; subsequent executions perform CMake rebuild and service restart |
| Main Processes | C++ wardy_edge_service, Python pose_fall_worker.py, GStreamer, MediaMTX, Caddy, Ollama |
| systemd Services | wardy-edge.service, wardy-pose-fall.service, ollama.service, wardy-data-maintenance.timer |
| Internal Communication | TCP 8443: HTTPS API · WebSocket · WebRTC WHEP signaling · TCP/UDP 8189: WebRTC ICE media · TCP 22: SSH maintenance |
| Internal Reserved Ports | Edge API 8787, RTSP 8554, and WebRTC HTTP 8889 are bound only to loopback and used exclusively for internal connections within Caddy and MediaMTX |
| Access Control | Caddy blocks external requests from private networks with a 403 Forbidden response, and CORS is allowed only for registered UI Origins and permitted internal network UI Origins |
| Firewall Policy | The installation script does not directly modify UFW rules; verify host and router firewalls to ensure reachability of TCP 8443, TCP/UDP 8189, and maintenance TCP 22 from the internal network |
| TLS · Authentication | Store Wardy local CA and Jetson server certificates in /etc/wardy/tls, terminate TLS at Caddy, and use internal access tokens for API and WebSocket only within the edge device |

**Windows (UI Development · Verification Client)**
| Item | Development Environment and Settings |
|---|---|
| Operating System·Architecture | Microsoft Windows 11 Pro 10.0.26200 · x64/AMD64 |
| Shell Environment | PowerShell 7.6.4 · Windows PowerShell 5.1.26100.8115 |
| Source·Remote Tools | Git for Windows 2.53.0.windows.2 · OpenSSH for Windows 9.5p2 · LibreSSL 3.8.2 |
| Browser | Google Chrome 151.0.7922.138 |
| Frontend Version | Vite 7.3.6 · TypeScript 5.9.3 · tsx 4.23.9 · Node.js 26.4.0 · npm 11.17.0 |
| Responsible Role | Run Vite UI development server, render browser screen, verify Jetson API·events·WebRTC video |
| Start Method | `.\start_windows.ps1` — On first run: execute `npm ci`, copy and install Jetson CA certificate, perform connection check, then run Vite UI |
| UI Access | Default http://localhost:8000. AI inference and camera processing are performed on Jetson, not Windows |
| Certificate Trust | Import only Jetson's public CA certificate and register it in the Windows Trusted Root store using `certutil -addstore -f Root` |
| Internal Communication | Connect to Jetson TCP 8443 for HTTPS API·WebSocket·WHEP signaling; receive WebRTC video via TCP/UDP 8189 |
| Firewall Policy | The start script does not directly modify firewall rules. Verify that outgoing TCP 8443 and TCP/UDP 8189 to the internal network are allowed. Inbound TCP 8000 is required only when exposing the UI to other devices |
| Connection Check | `Test-NetConnection` internal network address -Port 8443; verify health·operations API·WHEP signaling using `edge\scripts\test_windows_connection.ps1` |
| Remote Service Check | Connect to Jetson via SSH and check `systemctl status wardy-edge.service wardy-pose-fall.service` |

**macOS (UI Development·Verification Client)**

| Item | Development Environment and Settings |
|---|---|
| Operating System·Architecture | macOS 26.5.2 · Build 25F84 · Apple Silicon arm64 |
| Shell·Source Tools | zsh 5.9 · Apple Git 2.50.1 · OpenSSH 10.2p1 · LibreSSL 3.3.6 |
| Frontend Execution Environment | Node.js 26.4.0 · npm 11.17.0 · Vite 7.3.6 · TypeScript 5.9.3 · tsx 4.23.9 |
| Certificate·Development Tools | OpenSSL 3.6.3 · Python 3.14.7 · CMake 4.3.0 · macOS Keychain tools |
| Browser | Google Chrome 151.0.7922.138 |
| Responsible Role | Run Vite UI development server, render browser screen, verify Jetson API·events·WebRTC video, provide Wardy UI to mobile phone on the same internal network |
| Start Method | `./start_macos.sh` — On first run: execute `npm ci`, register Jetson CA trust, generate macOS local UI CA·HTTPS certificate, then run Vite UI |
| UI Access | Use `https://<Mac-LAN-IP>:8000` from Mac and mobile phone. Save the Jetson address in `.wardy-device` to reuse it from the next execution |
| Certificate Trust | Register Jetson CA in System Keychain; register Mac UI local CA in Login Keychain. Set trust for Mac UI·Jetson certificates once on the first run for mobile phones |
| Internal Communication | Connect to Jetson TCP 8443/TCP·UDP 8189; mobile phone connects to Mac TCP 8000 for UI access |
| Bypass Connection | If direct Jetson connection is impossible, prepare SSH alias tunnel and macOS loopback alias to connect to the same HTTPS address |
| Status Check | `curl --cacert "$HOME/Library/Application Support/Wardy/wardy-ca.crt" https://<Jetson-LAN-IP>:8443/api/health` |
| Remote Service Check | `ssh JetsonAlias 'systemctl status wardy-edge.service wardy-pose-fall.service'` |

### 2.3 Tools & Models
| Category | Tools/Models Used |
|---|---|
| Code Version Management | GitHub (github.com/mumallaeng/wardy) |
| Jongmin · M-01 Person Detection Model | Hugging Face (jjm15955/wardy-m1-person-detector) |
| Yeonwoo Kim · M-04 Fall Detection Model | Hugging Face (mumallaeng/wardy-m4-fall) |
| Jiwon Park · M-05 Hazard Detection Model | Hugging Face (chocochip119/wardy-m05-hazard-detector) |
| Edge Device | NVIDIA Jetson Orin Nano |
| Operating System/GPU Platform | Ubuntu 22.04 LTS, JetPack SDK 6.2.2, CUDA 12.6, cuDNN 9.3, TensorRT 10.3 |
| Video Input | USB Webcam, UVC, V4L2 |
| AI Model Development | Python 3.10, Jupyter Notebook, PyTorch, Ultralytics YOLO11n, OpenMMLab MMPose·RTMPose-M, ONNX |
| AI Inference Execution | C++, OpenCV, ONNX Runtime, TensorRT |
| Video Transmission | GStreamer, MediaMTX, WebRTC |
| Web UI | TypeScript, Vite, HTML, CSS |
| API/Security Communication | Caddy, HTTPS, TLS |
| Data Storage | SQLite |
| Local LLM | Ollama, Qwen3.5:4b |
| Build/Test | CMake, CTest, npm, Vitest |
| Service Management | systemd |
| Documentation/Diagrams | Markdown, Draw.io, PlantUML, Mermaid, DBML |

Generative AI was utilized as a coding and research assistance tool. For local CLI, OpenAI Codex CLI (GPT-5.6 series) and Anthropic Claude Code (Claude Sonnet 5) were used; for web chat, ChatGPT (GPT-5.6 Pro mode), Claude (Claude Sonnet 5), and Google Gemini (Gemini Flash) were employed in parallel; Nano Banana 2 (Gemini 3.1 Flash Image) was used for generating images for presentation materials.

## 3. System Architecture (Architecture)

### 3.1 Overall System Structure

<img width="1400" height="627" alt="image1" src="https://github.com/user-attachments/assets/8b4e861f-30c4-4921-b9c7-4310e9a99ef4" />

Wardy centers on a structure where the C++ Edge Service on the Jetson Orin Nano receives USB camera video, acquires frames via GStreamer appsink, executes M-01 person detection based on TensorRT, and transmits the results to the Python pose_fall_worker through a Unix domain socket. Within the Python side, the Tracking Runtime assigns a `track_id` for anonymous tracking (M-02). Subsequently, within the same Runtime, posture estimation (M-03) and temporal fall detection (M-04) execute sequentially, returning the fall probability and suspected fall result back to the C++ service.

On a separate path of the C++ Edge Service, M-05 hazard detection searches for hazardous object locations across the entire frame. If these locations are close to the person's position identified by M-01, a hazard proximity event is generated. The accumulated events and states are stored in SQLite and transmitted to the browser UI via HTTPS API, WebSocket, and WebRTC. When a user requests a daily summary, M-06 queries SQLite events and generates a summary using the local Ollama Qwen3.5 model before returning it.

### 3.2 Event·Care State Definitions

| <img width="1400" height="261" alt="image2" src="https://github.com/user-attachments/assets/9fb6b502-16f0-4468-b6d1-287cbdfc416b" /> | <img width="1400" height="525" alt="image3" src="https://github.com/user-attachments/assets/a66bbf2e-d268-4250-9340-d9431a24ff6d" /> |
|:---:|:---:|

The system normalizes the raw inference results of each AI module into a common event·care state contract. Situations requiring verification, such as suspected falls, prolonged inactivity, and hazard proximity, are defined as events. These events are aggregated to calculate the current care recipient's status (Normal, Warning, Caution, Emergency). This structure manages the flow from event occurrence to care state updates as a single common contract, reflecting M-01~M-05's disparate outputs in a consistent manner on the user interface.
### 3.3 Software Layers

<img width="1400" height="962" alt="image4" src="https://github.com/user-attachments/assets/264810ec-2d38-419c-9510-e78cdb113729" />

Wardy's software is divided into the C++/Python Jetson Edge layer responsible for camera input and AI inference, the service layer managing events, state, and storage, the communication layer delivering results via HTTPS and WebRTC, and the browser UI layer displaying them on screen. Clear boundaries are established between layers so that changes to inference logic do not affect the communication or UI layers, while conversely, UI requirement changes do not disrupt the inference pipeline structure.

### 3.4 Camera Preview, State Processing (Camera Preview & State Processing)

| <img width="1000" height="880" alt="image5" src="https://github.com/user-attachments/assets/5a605323-3bb7-47d0-beeb-bedbee225acc" /> | <img width="1099" height="854" alt="image6" src="https://github.com/user-attachments/assets/11392b59-cabe-480a-bc16-b14cc6e0d8a9" /> |
|:---:|:---:|

The browser UI provides a real-time camera preview from Jetson based on WebRTC (WHEP) and overlays M-01~M-05 inference results (person box, pose, fall suspicion, hazardous objects) on top. The state processing layer manages rules for merging, verifying, and clearing events entering simultaneously from multiple modules into a single care state; upon event occurrence, the state is updated based on severity and maintained until the user confirms it or processes it as a false alarm.

Wardy unifies management of events, states, evidence data, and model datasets in a single SQLite Database. The schema is broadly divided into four groups by role. First, `events` and `system_state` record raw events generated by each module (e.g., `occurred_at`, `event_type`, `object_class`, `care_status`) and the current care state (`care_state`, latch status), serving as input for UI event logs and M-06 daily summaries. Second, `scenes`, `media_collection_settings`, and `notification_settings` manage storage paths for evidence photos/videos and retention policies (original/capture interval capture, retention period, notification conditions) to control storage capacity and personal data retention periods. Third, `dataset_samples`, `tracking_samples`, `subject_reference_samples`, and `identity_reviews` store learning/verification samples and audit trails used for M-01~M-05 relearning and identity verification, enabling reuse of data collected during operation in the next model improvement cycle. Fourth, `subjects`, `managed_terms`, and `schema_metadata` store registered care subjects, managed term dictionaries (class/state names), and schema version information to allow multiple modules to exchange data using common terms and schemas. All tables share UTC-based timestamps (`created_at`/`updated_at`) to enable reconstruction of event occurrence order and state change history chronologically.

### 3.5 Database

<img width="1400" height="910" alt="image7" src="https://github.com/user-attachments/assets/2089718f-4ec3-4a09-a12e-fbe0e92f7745" />

This is the structure of a unified SQLite Database for events, states, evidence data, and model datasets using the aforementioned four-group schema.

## 4. Detailed Design (AI Models by Module)

### 4.1 M-05. Hazard Object Detection (Hazard Object Detection)

#### 4.1.1 Purpose and Structure

<img width="500" height="333" alt="image8" src="https://github.com/user-attachments/assets/1fcd4280-8b92-4748-9056-4271df1f833c" />
To judge hazardous situations within the home, a separate hazard detection pipeline in Python pose_fall_worker identifies object locations across all frames, and the C++ Edge Service generates a hazard proximity event when comparing these positions to the location of the person on M-01. The target classes are Scissors, Knife, Cutter, and Syringe (4 types). The detection function locates the position and class of hazardous objects in real-time camera video, while the operational environment is On-Device real-time inference based on Jetson and Logitech C270. Hazard verification up to the real-environment stage has been completed for scissors, cutters, and syringes; however, acquiring physical data for Knife remains an additional task.

#### 4.1.2 Dataset Collection and Preprocessing

<img width="1009" height="225" alt="image" src="https://github.com/user-attachments/assets/260a9de3-608e-450e-9d8b-17b2d4f2afb4" />

Hazardous object images were collected from public datasets, and the Scissor·Knife·Cutter·Syringe 4 classes were integrated into a learning dataset in YOLO format. The procedure proceeded in the following order: (1) collection of hazardous object images from public datasets, (2) unification of image and label formats to YOLO format, (3) organization into 4 classes, and (4) division into Train/Validation/Test data.

| Class | Number of Images |
|---|---|
| Scissor | 2,000 |
| Knife | 1,564 |
| Cutter | 1,010 |
| Syringe | 1,197 |
| Total | 5,771 |

The data was divided into Train (4,623 images), Validation (579 images), and Test (569 images).

#### 4.1.3 Initial Model Training

Learning conditions were set based on YOLO11n. After confirming the Dataset·Label·learning environment via Smoke Test (5 epochs), full training was performed for 100 epochs, followed by evaluation using the Test Set to select best.pt.

| Item | Setting |
|---|---|
| Model | YOLO11n |
| Image Size | 640 x 640 |
| Batch Size | 16 |
| Smoke Test | 5 epoch |
| Full Training | 100 epoch |
| Class | 4 |

The performance of the initial model (V1) was mAP@0.5 83.1%, mAP@0.5:0.95 61.1%. Since class-specific performance differences were confirmed, Fine-tuning was planned for subsequent steps.

#### 4.1.4 Fine-tuning Experiments and Model Improvement

To compensate for the class-specific performance differences of the initial model, Fine-tuning was repeatedly performed by alternating data augmentation and Augmentation conditions.

| Model | Key Changes | mAP@0.5:0.95 | Decision |
|---|---|---|---|
| V1 | Initial training | 61.1% | Baseline |
| V2 | Dataset augmentation (Knife and negative samples) | 61.5% | Selected |
| V3 | Rotation 30° | 56.4% | Decreased |
| V4 | Rotation 15° | 56.8% | Decreased |
| V2+20 | Additional 20 epochs from V2 | 58.2% | Decreased |

Applying Rotation augmentation caused Test performance to decrease, and extending the number of epochs beyond V2 yielded no performance improvement. Based on this, V2 best.pt was selected as the final decision and used as the Base Model for subsequent C270 Fine-tuning. It was concluded that data composition and Augmentation conditions have a greater impact on Test generalization performance than additional learning.

#### 4.1.5 C270 Real-Environment Issue Identification and Additional Data Composition

When applying the selected V2 best.pt to the actual C270 webcam, distance, angle, background changes, and false-positive patterns that were difficult to detect in the existing Test Set were revealed in the real webcam environment. Scissors were detected relatively stably at close range, but Knife was undetected under most real-environment conditions, while Cutter and Syringe were primarily detected under frontal and close-range conditions. Additionally, False Positives where pens and general objects were misidentified as Scissors were confirmed.

To compensate for this domain difference, a total of 102 C270 real-world images (Scissors 38 images, Cutter 30 images, Negative 34 images) were additionally composed. Real-world data for Knife and Syringe could not be included in this additional composition.

#### 4.1.6 C270 Fine-tuning
We used V2 best.pt as the base model and added C270 real-world data to perform fine-tuning, adapting it to actual webcam environments. The fine-tuning strategy involved reusing the base model that had previously demonstrated the most stable test performance (V2 best.pt), incorporating C270 real-world data to reflect distance, angle, and background variations observed in actual webcams, applying no rotation augmentation to avoid the test performance degradation seen in previous rotation experiments, and focusing on verifying adaptation to the C270 environment rather than conducting long-duration retraining through short additional training.

| Item | Setting |
|---|---|
| Base Model | V2 best.pt |
| epoch | 20 |
| Image Size | 640 x 640 |
| Batch Size | 16 |
| Rotation | 0° |
| Patience | 10 |
| Device | GPU |

Based on the learning results, we selected V2 best.pt with the highest validation performance as the final model.

#### 4.1.7 Final Model Performance Evaluation

| <img width="400" alt="image13" src="https://github.com/user-attachments/assets/f8ef890a-4047-41f9-8c1d-b4ba8e46a427" /> | <img width="400" alt="image14" src="https://github.com/user-attachments/assets/1e6e9fc9-6b51-469b-acda-55160b129da9" /> |
|:---:|:---:|

After C270 fine-tuning, we evaluated the detection performance of the final best.pt using the existing test set. mAP@0.5 was 83.5%, and mAP@0.5:0.95 was 63.8%. Upon reviewing both the confusion matrix and precision–recall curve, Cutter and Syringe demonstrated high performance on the test set, while Knife showed relatively lower performance.

#### 4.1.8 Jetson + C270 Real-Environment Application Results

<img width="1005" height="286" alt="image" src="https://github.com/user-attachments/assets/95a630dd-8c41-44e1-969a-4d57ed097ca2" />

We applied the final best.pt to Jetson and verified actual dangerous object detection performance from Logitech C270 webcam video. The verification scope included Scissors, Cutter, and Syringe; Knife was not subjected to real-environment verification. Overall, knives were detected relatively stably, whereas cutters and syringes exhibited performance variance depending on distance and angle.

#### 4.1.9 Limitations and Improvement Directions

| <img width="500" alt="image18" src="https://github.com/user-attachments/assets/2a0ae071-23c5-4024-bc68-25bf32a88b65" /> | <img width="300" alt="image19" src="https://github.com/user-attachments/assets/f6b87c63-062c-4979-9a0d-78bdae55a06d" /> |
|:---:|:---:|

Based on undetected and false-positive cases identified during actual C270 testing, we compiled additional data collection requirements and model improvement directions. The ultimate goal is to reduce false positives by augmenting C270 real-environment data and improve generalization performance regarding distance and angle variations.

| Current Limitation | Improvement Direction |
|---|---|
| Scissor bias leading to misclassification of ordinary objects | Hard Negative Augmentation — Add Pen and Tool category data |
| Insufficient Knife detection — mostly undetected in actual environments | Acquire real-world Knife data — Diversify distance, angle, and occlusion conditions |
| Limited generalization for Cutter/Syringe — sensitive to distance and angle changes | Strengthen Cutter Hard Cases — Add front, back, side, and long-distance data |

### 4.2 M-01. Person Detection (Person Detection)

#### 4.2.1 Purpose and Structure

<img width="578" height="333" alt="image20" src="https://github.com/user-attachments/assets/acf39468-d44f-4c69-ad8f-76a53b5a7659" />
The C++ Edge Service receives camera frames via a GStreamer appsink and executes TensorRT-based YOLO11n to detect people. To enable fall detection and posture analysis, the Person Detection model was trained with the goal of reliably detecting people across diverse environments and postures. The objectives include stably detecting multiple people at varying distances, accurately detecting individuals in various postures such as standing or sitting, and reliably detecting people within actual home camera environments.

#### 4.2.2 Dataset Collection and Preprocessing

A Person Dataset was collected from Roboflow Universe and converted to YOLO format, with all person objects unified under a single `person` class. The procedure followed these steps: (1) collect the Person Dataset from Roboflow Universe, (2) standardize image and label formats to YOLO format, (3) unify all person objects into a single `person` class, and (4) split the data into Train/Validation/Test sets.

#### 4.2.3 Model and Training Methodology

After validating the dataset and learning environment via Smoke Test, full training was performed for 50 epochs using YOLO11n based on the configured learning conditions. The training workflow proceeded as follows: Smoke Test (verify normal operation of Dataset and learning environment) → Full Training (50-epoch base learning) → Model Evaluation (performance assessment based on Precision, Recall, and mAP). The Full Training configuration included Model `YOLO11n`, Image Size 640×640, Batch Size 16, and Epoch 50.

#### 4.2.4 Full Training Learning Results

<img width="1400" height="700" alt="image21" src="https://github.com/user-attachments/assets/fcf8b63b-df4d-4a51-a5d4-2fd6bc7e3a73" />

Through the learning process over 50 epochs, the model's convergence characteristics and key performance metrics were verified. It was confirmed that stable learning occurred over 50 epochs as both Training/Validation Loss decreased while Precision, Recall, and mAP increased.

| Metric | Value |
|---|---|
| Precision | 0.925 |
| Recall | 0.869 |
| mAP50 | 0.945 |
| mAP50-95 | 0.758 |

#### 4.2.5 Full Training Performance Analysis

| <img width="400" alt="image22" src="https://github.com/user-attachments/assets/8ba03c68-7f20-44f6-999c-b2825342152e" /> | <img width="400" alt="image23" src="https://github.com/user-attachments/assets/c2db3480-6640-4065-be4e-c7701993c3c8" /> |
|:---:|:---:|

Quantitative performance was analyzed using the Precision-Recall Curve and Confusion Matrix. While high Person Detection performance was achieved in quantitative evaluation, some false positives and missed detections also existed.

#### 4.2.6 Test Set Detection Results

| <img width="400" alt="image24" src="https://github.com/user-attachments/assets/75570cb1-f05a-4746-866b-b52da2fa43ea" /> | <img width="400" alt="image25" src="https://github.com/user-attachments/assets/d6a5da8f-365a-42e8-9e3d-7ea9e32bd8c1" /> |
|:---:|:---:|

The final model was applied to the Test Set, which was not used during training, to verify Person bounding box outputs and confidence scores. Application of the Test Set confirmed overall stable person detection performance across various scenes not encountered during training.

#### 4.2.7 Jetson Board Application Results — Normal Detection Cases

| <img width="400" alt="image26" src="https://github.com/user-attachments/assets/afd8fa91-a860-408a-a195-85b2f7a3d7c3" /> | <img width="400" alt="image27" src="https://github.com/user-attachments/assets/9e3b2717-2f5b-4e48-8f0d-714672d9d037" /> |
|:---:|:---:|
Verified that real-time Person Detection operates correctly on the Jetson Board environment. Multiple persons could be detected simultaneously in the actual board environment, and Person Detection results were displayed correctly across various distances and positions.

#### 4.2.8 Jetson Board Application Results — Limitation Cases

| <img width="400" alt="image28" src="https://github.com/user-attachments/assets/534da882-e1bd-4d23-b703-23b3ed4d3f96" /> | <img width="400" alt="image29" src="https://github.com/user-attachments/assets/14e8f909-2fc0-43b4-8581-975bd45f3f15" /> |
|:---:|:---:|

While overall stable detection performance was confirmed, False Positives and partial detection cases occurred in certain environments. Analysis of factors such as background, occlusion, and shooting angles led to the derivation of additional Fine-tuning directions.

#### 4.2.9 Limitations and Improvement Directions

Based on the board application results, additional learning directions for actual environment response were organized. The ultimate goal is to stably detect persons in real-life living spaces to improve the reliability of subsequent Fall Detection inputs.

| Current Limitations | Improvement Plan |
|---|---|
| False Positives occur on objects with shapes similar to humans, such as cup handles, chairs, and bags | Add actual one-room, kitchen, and bed-side scenes to the dataset based on Roboflow Universe |
| Bboxes capture only parts of a person in cases involving screen edges or partial occlusion | Add Hard Negative Images to reduce misdetection of non-human objects |
| Differences exist between the learning Dataset and the actual board camera viewpoint | Supplement data on elderly postures and home camera viewpoints to fine-tune for Wardy environments; repeat Jetson real-time testing to adjust Thresholds and post-processing conditions |

### 4.3 M-02. Tracking — Person Tracking

#### 4.3.1 Purpose and Structure

<img width="756" height="435" alt="image30" src="https://github.com/user-attachments/assets/3af58c4c-1365-4591-98c0-1bef507c2c15" />

The C++ PoseFallClient serializes frames and M-01 detection results into JSON and sends them to the Python pose_fall_worker via a Unix domain socket. Inside the worker, the Tracking Runtime generates and maintains track_ids for each person. Since M-03·M-04 must analyze a single person's posture over several seconds, temporary track_ids connecting frames are required.

#### 4.3.2 Algorithm Selection: SORT vs MLP Comparison

<img width="1197" height="613" alt="image31" src="https://github.com/user-attachments/assets/7f81ce55-36c7-4aa3-93df-ed3bd098fbb9" />

The combination of Kalman Filter + IoU Gate + Hungarian Matching, which is the classic baseline algorithm in the Tracking field (SORT: Simple Online and Realtime Tracking), was used as the base. Additionally, an MLP (Multi-Layer Perceptron) trained based on motion features was applied for comparison to explore further improvements.

#### 4.3.3 Tracking Processing Process (Process)

The input consists of frames and bbox positions/scores, while the output is an anonymous track_id. The processing proceeds through the following steps:
- **Kalman Filter**: Predicts the current bounding box location using accumulated information from past frames. It is an optimal estimation algorithm that finds the current state by maximizing noise removal (filtering) between measurements containing noise and the predicted state.
- **Candidate Restriction 1. IoU (Intersection over Union)**: Calculates how much the predicted bounding box overlaps with a new detection bounding box, serving as core material for matching cost and the gate (whether to admit a matching candidate). It is the ratio of the intersection area of two regions to their union area (0~1), representing a standard similarity metric in object detection and tracking fields to measure whether two boxes refer to the same object.
- **Candidate Restriction 2. MLP (Multi-Layer Perceptron)**: Takes motion features such as IoU, center displacement, and size change as input to directly compute the matching cost for determining whether two bounding boxes belong to the same person. Instead of fixing input-output relationships with human-designed formulas, it is a neural network that approximates non-linear decision boundaries by learning linear transformations and non-linear activation functions across multiple layers using data.
- **Hungarian Matching**: Finds and connects 1:1 matching combinations where the total cost is actually minimized within the cost matrix between predicted bounding boxes for each track and detections in the current frame. It is a combinatorial optimization (linear assignment problem) algorithm that guarantees a globally optimal 1:1 assignment in polynomial time given a cost matrix.
- **Track Lifetime(min_hits/max_age_frames)**: Registers unmatched detections as new track_ids, and eliminates tracks that have been unmatched for more than a certain number of frames (10) to continuously manage the set of valid tracks. These are tracker survival policy parameters determining how long to tolerate temporary observation breaks due to occlusion and how many frames of noise-induced false positives to filter out before elimination.

#### 4.3.4 Adoption Results

M-02A (SORT family) and M-02B (MLP family) were compared using four metrics: IDF1, MOTA, ID switch, and average latency.

| Metric | M-02A | M-02B | Judgment |
|---|---|---|---|
| IDF1 | 0.7807 | 0.7320 | A superior |
| MOTA | 0.9147 | 0.8654 | A superior |
| ID switch | 134 | 660 | A superior |
| Average latency | 2.87 ms/frame | 11.08 ms/frame | A superior |

Since M-02A (SORT family) was superior in all four metrics, M-02A was adopted as the final Edge basic tracker.

<img width="1400" height="466" alt="image32" src="https://github.com/user-attachments/assets/9bef9432-0c9c-47c8-ad9f-9aa2ef6c2671" />

### 4.4 M-03. Pose Estimation — Posture Estimation

#### 4.4.1 Purpose and Structure

<img width="579" height="348" alt="image33" src="https://github.com/user-attachments/assets/55eb7115-1561-463f-83b5-1c66dad12ecd" />

The TrackingPoseFallRuntime of Python pose_fall_worker transmits the track_id from M-02 and the person region to RTMPose-M, calculating COCO-17 keypoints and current posture for each person. The role of M-03 is to provide normalized joint data per person so that M-04 can analyze continuous posture changes of the same individual over time.

#### 4.4.2 Method Selection

We adopted a 2D Human Pose Estimation method to estimate body joint positions from a single RGB image, using RTMPose from the OpenMMLab MMPose framework to extract COCO-17 joint coordinates and confidence scores. We calculate posture states (standing, sitting, lying down, unknown) based on distances, angles, and torso directions of joints, and transmit the joint point sequence and posture state to M-04.

#### 4.4.3 Detailed RTMPose Model Selection: From Tiny to Medium

Since it is an On-Device model, we initially used the lightweight RTMPose-t (Tiny). The test data was a pipeline that validated without issues, but in real-world testing, situations where posture output disappeared occurred. The initial posture determination logic was as follows.
| Judgment Item | Calculation Formula | Result |
|---|---|---|
| Input Validity | COCO-17 (17, 3), confidence ≥ 0.30 for both shoulders and pelvis, torso length ≥ 1 px | unknown if conditions are not met |
| Torso Axis | Calculate a 2D vector torso=(dx,dy) pointing from the center of both shoulders to the center of both hips | Calculate torso direction and length |
| Lying Down | abs(dx) >= abs(dy) × 0.85 | If true, judge as lying and terminate |
| Lower Limb Visibility | Use only joints with confidence ≥ 0.30 among left and right knees | unknown if no visible knee |
| Sitting | hip_to_knee_y < torso_length × 0.65 | If true, judge as sitting |
| Standing | Does not meet the lying or sitting conditions above | standing |

To solve this problem, we switched to a more accurate model, RTMPose-M(Medium), and excluded incomplete results where only some joints were detected. The posture classification logic was further refined through real-world testing as shown below.

| Judgment Item | Revised Calculation Formula | Result |
|---|---|---|
| Input Validity | COCO-17 (17, 3), confidence ≥ 0.30 for both shoulders and pelvis, torso length ≥ 1 px | Same as before: unknown if conditions are not met |
| Torso Axis | Calculate a 2D vector torso=(dx,dy) pointing from the center of both shoulders to the center of both hips | Same as before: calculate torso direction and length |
| Lying Down | abs(dx) > abs(dy) × 1.20 | Judge as lying only if the torso is closer to horizontal and terminate |
| Lower Limb Visibility | Maintain the knee confidence ≥ 0.30 threshold and also check hip-knee-ankle confidence for usable legs | unknown if no visible knee; calculate knee angle if a complete leg is visible |
| Sitting | Average knee angle < 145°. If no valid angle exists or it falls in the 145°~155° range, use hip_to_knee_y < torso_length × 0.50 fallback | If conditions are met, judge as sitting |
| Standing | Average knee angle ≥ 155°. If angle determination is impossible or it falls in a buffer zone, use distance fallback with value ≥ 0.50 | If conditions are met, judge as standing |

We adjusted the torso angle threshold for lying down from 0.85 to 1.20 to strictly judge lying only when the torso is closer to horizontal. For sitting and standing judgments, we introduced knee angles (145°/155° thresholds and buffer zones), demoting the previous simple distance ratio (hip_to_knee_y) method to a fallback. Additionally, we added a new 5-frame majority voting time-axis stabilization to mitigate posture judgments that fluctuated frame by frame.

#### 4.4.4 Posture Estimation Processing Process (Process)

Input consists of frame + person bbox + track_id; output is COCO-17 keypoints [x, y, score] + posture. The processing steps are as follows:

- **192×256 Affine Transform (Preprocessing)**: Expand the crop area to provide 1.25x margin over the original bbox passed by M-01/M-02 to prevent joints from being clipped at box boundaries. Convert this expanded crop area to the model-required fixed size of 192×256 and process BGR→RGB normalization to create the model input.
- **RTMPose-M(SimCC decode)**: Input the preprocessed crop image to infer (x, y, confidence) for each of the COCO-17 joints. This is a lightweight Top-Down structure unique to RTMPose that achieves stable sub-pixel precision by solving independent 1D classification(bin) problems for x-axis and y-axis coordinates instead of directly regressing joint coordinates.
- **Posture Rule (Geometric Rules)**: Calculate torso inclination and knee flexion angle using only the 17 joint coordinates output by RTMPose to distinguish among standing/sitting/lying/unknown. This is a rule-based judgment method that determines state by comparing angles and ratios between joint vectors against fixed thresholds, without training a separate classifier.
- **5-frame Smoothing**: Bundle posture judgments that may fluctuate per frame into a majority vote over the most recent 5 frames to mitigate the leakage of single instantaneous misjudgments as events. This post-processing technique smooths noisy instantaneous judgments via majority voting along the time axis, requiring no additional learning.

### 4.5 M-04. Temporal Fall Detector — Fall Detection

#### 4.5.1 Purpose and Method Selection
<img width="507" height="391" alt="image34" src="https://github.com/user-attachments/assets/0fb60dc9-4774-439c-a036-57314c864285" />

A fall is an incident where a person slips, trips, or falls and gets injured without their consent. To distinguish between routine lying down and actual falls, Temporal Fall Detection (Temporal Fall Detection) is required to analyze the continuous posture changes of the same individual over time to determine whether a fall occurred. Considering short posture sequences and real-time edge processing, we selected a lightweight temporal baseline, TemporalFallGRU (Unidirectional GRU), and trained it directly on joint sequences extracted from the URFD (UR Fall Detection) dataset. The model accepts 20 frames (2 seconds) × 80 features of joint sequences to calculate fall confidence, runs a Fast Path for rapid transitions from standing to lying in parallel, and combines this with the M-03 posture to generate suspected fall events.

M3, which is a Python Runtime, accumulates joint data per track_id over 20 frames, executes TemporalFallGRU and sudden posture transition rules, and returns fall probability and suspected fall results to a C++ service.

#### 4.5.2 Fall Detection Processing Process (Process)

The input is a 20-frame pose sequence per Track ID (keypoints + posture), and the output is fall_confidence + fall_suspected + posture. The processing process is as follows:

- **History Buffering (Sliding Window)**: Continuously appends the pose results of the recent 20 frames (window_frames) per track to a deque, always maintaining the most recent 2 seconds. It acts as a circular buffer that automatically discards the oldest entries when exceeding a fixed length (maxlen), maintaining only the latest segment without recalculating the entire frame in a streaming manner.
- **Fast Path Rules (Rapid Transition Detection)**: If the previous two frames are consecutive standing and the current frame switches to lying, it immediately generates a fall candidate with confidence 1.0 without waiting for the window to fill. This is an exception handling rule based on conditional logic comparing only the recent posture history of three items (previous two + current) without model inference, serving as a rule-based bypass of the learning model in situations where latency is critical.
- **Feature Engineering**: Executed only when the Fast Path is not triggered and the window is fully filled with 20 frames, it converts the 20 pose results into a 75-dimensional vector sequence including joint coordinates, confidence, and derived features. This is a feature extraction step that transforms raw coordinates into fixed-shape numerical tensors consumable directly by the model.
- **Normalization**: Standardizes this 75-dimensional vector using pre-determined mean and standard deviation per feature during training. It applies z-score standardization to align features with different scales near a mean of 0 and variance of 1, preventing the model from biasing toward specific features.
- **TemporalFallGRU Inference**: Feeds the normalized 20-frame sequence into the GRU model to obtain logits, applies sigmoid to convert them into fall confidence between 0 and 1. This is an inference operation where a Recurrent Neural Network (GRU) summarizes the temporal patterns of the entire sequence using learned weights into a single scalar probability.
- **Threshold Application**: If confidence exceeds the threshold, it makes a final determination of fall_suspected=True. At this point, the code has a hard lower limit fixed so that the threshold never drops below 60%, regardless of the value suggested by the model. This decision threshold converts continuous probability outputs into binary decisions (fall/normal) and serves as an operational safety mechanism to prevent the threshold from accidentally lowering due to model retraining.

In summary, this structure evaluates how quickly and abruptly posture collapses from both the rapid transition rule and the temporal model side together to calculate fall likelihood.

### 4.6 M-06. Daily Summary

#### 4.6.1 Necessity and Design

A daily summary function was required so that users can quickly grasp the overall care situation without individually checking accumulated safety events throughout the day. To avoid transmitting sensitive care records to external servers, we adopted an Edge Device-based On-device LLM approach using Ollama. After comparing models through self-tests, Qwen3.5:4B was selected as the final model.
Date-specific events stored in SQLite are converted into anonymized text for input, and output is controlled by applying temperature=0, JSON Schema, and fixed aggregation sentence verification. When Timeout, model errors, or unsuitable responses occur, a Deterministic Fallback Summary is returned to ensure that incorrect summaries do not be generated even if the LLM fails. Verified Korean daily summaries are delivered via HTTPS API and displayed in the "Today's Summary" section of the browser UI.

When a user requests a daily summary, the flow involves the DailySummaryService in the C++ Edge Service querying SQLite events and returning the summary generated by calling the local Ollama Qwen3.5 model to the UI via HTTPS API.

## 5. Implementation and Integration Verification

### 5.1 Development, Deployment, and Verification Flow

<img width="1400" height="754" alt="image35" src="https://github.com/user-attachments/assets/cf8d02db-4aab-483c-a1f8-1d9b19830937" />
Wardy developed by first training and evaluating individual AI modules separately, integrating them into the Jetson Edge pipeline, and then re-verifying the integrated system under actual camera, lighting, and pose conditions. Although modules may demonstrate good performance during unit-level verification, new issues can arise at module boundaries after integration; therefore, a separate process was established to iteratively identify and resolve problems through repeated real-world testing post-integration.

### 5.2 Post-Integration Model Recognition and State Handling — Issue Resolution Log

After integrating M-01~M-06 into a single pipeline, the following issues were identified and resolved sequentially through repeated testing in actual shooting environments from 08-13 to 08-18.

#### 5.2.1 260813 — Investigation of Recognition Failure Causes and State Fixation Issues
| <img alt="0813-11 50 52" src="https://github.com/user-attachments/assets/0264857a-8562-4491-88c1-121d8b6d5c0d" /> | <img alt="0813-19 05 08-1" src="https://github.com/user-attachments/assets/5af3455e-0726-4314-bc04-1e2675c2151e" /> |
|:---:|:---:|
Initially, during integration, it was impossible to identify on-screen which class failed recognition and why, so debugging indicators were added to display class information. It was revealed that most values in the status screen were marked as uncheckable, indicating a need for correction regarding frequent state changes; specifically, cases were confirmed where the care state was erroneously fixed as urgent even while standing or sitting, or where sitting was misrecognized as lying down.

| <img alt="0813-19 05 08-2" src="https://github.com/user-attachments/assets/b4a28ea9-6634-40a4-baef-b0bf21c8310d" /> | <img alt="0813-19 05 08-3" src="https://github.com/user-attachments/assets/554446fb-4b7e-45fa-9551-2108a9b98119" /> |
|:---:|:---:|

In subsequent verified cases, it was frequently observed that the lying-down state was misrecognized as standing or sitting. Even when falls were correctly recognized, there was an issue where the state was immediately released in the following frame. Through this, we confirmed the requirement that if the lying-down state is maintained, the urgent state should also be maintained.
| <img width="480" height="262" alt="0813-20 28 47-1" src="https://github.com/user-attachments/assets/bbfe19a5-4f2e-4b76-b010-1d386a1afb2c" /> | <img width="480" height="264" alt="0813-20 28 47-2" src="https://github.com/user-attachments/assets/8b94d01c-88c2-46a7-9d6c-2adec10fe1ac" /> | <img width="480" height="266" alt="0813-20 28 47-3" src="https://github.com/user-attachments/assets/d2d5409e-282b-40ce-841d-9955ddf66d55" /> | <img width="480" height="264" alt="0813-20 28 47-4" src="https://github.com/user-attachments/assets/3041dc2b-a38d-419e-8a70-1d901e09202b" /> |
|:---:|:---:|:---:|:---:|
Fixed the issue where emergency states were arbitrarily fixed, and improved posture recognition by correcting the judgment criteria to properly detect lying down postures.

#### 5.2.2 260814 — Fall Detection Missed and Posture Misclassification Fixes</KEEP_BLOCK_0006>

| <img width="480" height="264" alt="0813-20 28 47-4" src="https://github.com/user-attachments/assets/3041dc2b-a38d-419e-8a70-1d901e09202b" /> | <img width="480" height="310" alt="0814-10 17 01" src="https://github.com/user-attachments/assets/99857ea1-f160-47ca-be00-a7de90e8b486" /> | <img width="480" height="264" alt="0814-10 18 17" src="https://github.com/user-attachments/assets/4491c3eb-0954-4914-9afa-697fca6d7fa8" /> | <img width="480" height="264" alt="0814-10 19 16-1" src="https://github.com/user-attachments/assets/5475ecab-0c42-42d8-a540-1651dcd26307" /> |
|:---:|:---:|:---:|:---:|

During the process of modifying the criteria for judging lying down postures, a regression occurred where falls were no longer recognized.

<img width="480" height="302" alt="0814-10 55 40-1" src="https://github.com/user-attachments/assets/183d8530-d83b-47ea-890d-b5aa6ea9c94d" />

To resolve this, we added a fall suspicion state to posture detection, allowing the system to either confirm a suspected fall or treat it as a misclassification.

<img width="480" height="264" alt="0814-10 19 57" src="https://github.com/user-attachments/assets/920361a6-e4fd-459f-9d45-9f1c14bd289b" />

We continued accumulating relevant data to distinguish between cases where fall detection was actually successful and those resulting in misclassification.

| <img width="480" height="348" alt="0814-11 35 23-1-성공" src="https://github.com/user-attachments/assets/0b7c981d-9f9c-461e-9f25-02230fb2dea9" /> | <img width="480" height="372" alt="0814-11 37 23-1-오탐" src="https://github.com/user-attachments/assets/07c85c22-4b81-4434-9068-8441a672704b" /> | <img width="480" height="346" alt="0814-11 37 23-2-성공" src="https://github.com/user-attachments/assets/ab337a61-6bc4-451f-a260-1df7001b1f65" /> |
|:---:|:---:|:---:|

Misclassifications were particularly frequent when distinguishing falls from scenarios showing only the upper body; in many instances, M-03 posture misclassifications did not progress to M-04 fall recognition. To address this, we accumulated data on both misclassified cases and successfully recognized cases to re-adjust the judgment criteria for M-03 Pose.

<img width="800" alt="0814-11 37 23-3-성공" src="https://github.com/user-attachments/assets/7af0e12c-f450-402d-a860-813aadeaff3b" />

#### 5.2.3 260817 — Fall Detection Accuracy Improvements</KEEP_BLOCK_0007>

| <img width="480" height="354" alt="0817-13 17 11-눕기낙상구분" src="https://github.com/user-attachments/assets/a825a2e1-20c9-4cc5-81fb-b5967e46d1c3" /> | <img width="480" height="350" alt="0817-13 19 31-눕기낙상구분" src="https://github.com/user-attachments/assets/b5107d28-c2b3-41f3-99fb-172386db3e4d" /> |
|:---:|:---:|

As a result of incorporating the previous fixes, fall detection accuracy improved, enabling the system to distinguish between intentional lying down and actual falls.

#### 5.2.4 260818 — Hazardous Material Proximity Event and UI Behavior Verification</KEEP_BLOCK_0008>
| <img width="1400" alt="image54" src="https://github.com/user-attachments/assets/dce2087f-af9e-4bc5-8db5-d40c847fd358" /> | <img width="1400" alt="image55" src="https://github.com/user-attachments/assets/2bf5e4b3-a0cd-4c12-97dc-8a9b152281f1" /> |
|:---:|:---:|

We identified the hazardous material proximity event to distinguish between a caution stage when far from people and an alert stage when close.

| <img width="480" height="302" alt="0814-11 35 23-2-event-log" src="https://github.com/user-attachments/assets/ea1ed30e-01a6-4e19-979f-6f305dfd65f0" /> | <img width="1400" alt="image56" src="https://github.com/user-attachments/assets/0be13d94-ea62-4465-8576-44c706082656" /> | <img width="1400" alt="image57" src="https://github.com/user-attachments/assets/9caa1d79-f556-4e35-b2bb-ae9c8e2b5e40" /> | <img width="1400" alt="image58" src="https://github.com/user-attachments/assets/c9c528f2-7558-4d7a-bf79-b2db8af85292" /> |
|:---:|:---:|:---:|:---:|

We also verified the remaining UI actions, including event logging, the data workspace, settings, etc.

### 5.3 Summary of Verification Results

| Item | Verification Content | Result | Achievement Status |
|---|---|---|---|
| M-01 Person Detection | Real-time detection on Test Set and Jetson Board | Confirmed stable detection with Precision 0.925, Recall 0.869, mAP50 0.945; some false positives due to similar shapes exist | Achieved |
| M-02 Person Tracking | Comparison of M-02A/M-02B (SORT vs MLP) | M-02A outperformed in all metrics including IDF1, MOTA, ID switch, and latency; adopted as the Edge default tracker | Achieved |
| M-03 Pose Estimation | RTMPose-t/M comparison, repeated real-world testing with correction | Stabilized lying recognition through switching to RTMPose-M and threshold/majority voting correction | Achieved |
| M-04 Fall Detection | Repeated verification of integrated real-world falls and false positives | Immediate detection of rapid transitions via Fast Path + GRU combination; false positives suppressed with a 60% lower threshold | Achieved |
| M-05 Hazardous Material Detection | Test Set evaluation + Jetson/C270 real-environment application | mAP@0.5 83.5%, mAP@0.5:0.95 63.8%; confirmed real-environment detection of Scissors/Cutter/Syringe; Knife not verified | Achieved |
| M-06 Daily Summary | JSON Schema and aggregation sentence verification, Fallback behavior check | Verified Korean summary returned normally to UI; Deterministic Fallback operates correctly on errors | Achieved |
| Integrated UI | Verification of event logging, data workspace, and settings screen actions | Normal operation confirmed (260818) | Achieved |

These results synthesize the four module-specific performance metrics from this chapter and the integrated verification records from Section 5.2; remaining limitations and improvement directions are discussed in Chapter 6.

## 6. Results Analysis and Troubleshooting

### 6.1 Key Issues Identified During Integrated Verification

The common causes of problems that repeatedly occurred during the integrated verification period from 08-13 to 08-18 can be summarized into two main categories. First, it was a boundary issue where false positives in M-03 pose estimation were directly propagated as fall recognition in M-04. Because fall detection operates on top of pose determination, when the latter fluctuates, the former also fluctuates; thus, improving the accuracy of a single module alone was insufficient to improve the overall fall recognition rate.

Second, it was a defect in the state transition logic where the care status, once fixed as emergency, did not automatically clear in subsequent frames, or conversely, failed to clear immediately even when a fall was recognized. These two causes were not independent; they overlapped by having the state incorrectly changed due to pose false positives and then being re-fixed by the state transition logic.

### 6.2 Improvement Plan (Remaining Module-Specific Improvements)

At the conclusion, we summarized the remaining improvement directions for each module as follows.
| Module | Remaining Improvements |
|---|---|
| M-01 Person Detection | Improve detection accuracy regarding lighting changes, shooting distance, and occlusion of body parts. |
| M-02 Object Tracking | Minimize tracking interruptions and target switching caused by multiple people and occlusions. |
| M-03 Pose Estimation | Raise the baseline to enable stable pose classification across various camera angles. |
| M-04 Fall Detection | Acquire real-world data to distinguish between slow-lying actions and actual falls. |
| M-05 Hazard Detection | Supplement data with items held at various angles and backgrounds to improve real-world recognition rates. |
| M-06 Daily Summary | Develop in a direction that enhances sentence naturalness while maintaining event factual accuracy. |

### 6.3 Platform-Level Improvement Measures

At the platform level, additional verification is required regarding long-term operational performance and network reconnection stability. Initiatives include introducing initial setup automation to simplify certificate configuration and service recovery processes, establishing a deployment management system that supports model updates and rollback to previous versions, and leaving future multi-camera integration and external notification functionality as tasks for subsequent stages.

The subsequent direction involves improving stability in actual environments beyond the prototype level.

## 7. Conclusion and Reflection

We have completed an on-device safety verification system connecting camera input, AI inference, event judgment, user confirmation, and daily summaries. We experienced that performance differences arise significantly based on lighting, shooting angles, occlusion, and other factors in real environments when using public datasets and pre-trained models, underscoring the importance of validation based on real-world data. We confirmed that while AI model accuracy is crucial, overall service quality is also determined by tracking continuity, event state management, network communication, and UI representation. By integrating C++/Python inference, TensorRT, WebRTC, HTTPS, and SQLite within a Jetson environment, we gained experience in concurrently considering AI model development and system engineering. We also realized that the process of iteratively improving false alarms and connection issues is as important as detection performance, enabling users to understand and directly verify detection results. Despite limited time and a single-camera environment, we successfully implemented fall detection and incident verification workflows, thereby validating the potential for home-based care safety assistance systems.

We moved beyond merely using rapidly advancing AI to understanding the principles of how data is input and inference results are generated through this project. We were able to quickly learn and connect to actual implementation in areas such as object tracking, pose estimation, time-series analysis, and edge deployment—fields we encountered for the first time by leveraging AI. Furthermore, our ability to formulate more specific questions after understanding the principles and verify AI answers to obtain necessary results improved concurrently. We learned that while AI lowers entry barriers in unfamiliar fields and significantly accelerates learning and implementation, foundational knowledge is required to judge and modify results for proper utilization. Through this project, we felt that an important capability in the AI era is not merely the ability to use tools, but the ability to define problems, collaborate with AI, and complete results as actual systems. This was a project where we experienced connecting multiple technologies into usable services rather than simply improving the performance of a single AI model.

## References

[0] CDC, Older Adult Falls Data and Statistics, https://www.cdc.gov/falls/data-research/index.html

[1] Study on Risk Factors for Falls in Elderly People with Dementia, https://pmc.ncbi.nlm.nih.gov/articles/PMC5435396/

[2] WHO, Falls, https://www.who.int/news-room/fact-sheets/detail/falls

[3] Ultralytics YOLO11 Documentation

[4] OpenMMLab, MMPose / RTMPose

[5] Bewley et al., Simple Online and Realtime Tracking (SORT)

[6] URFD (UR Fall Detection Dataset)

[7] Roboflow Universe — Person Detection Datasets

[8] NVIDIA Jetson Orin Nano / JetPack / TensorRT Documentation
