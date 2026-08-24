# Wardy — 가정용 돌봄 안전 모니터링 On-Device AI 플랫폼

지켜조(9조) 김연우, 박지원, 조정민

2026.08.05~2026.08.19

## 목차

1. 개요 (Overview)
   - 1.1 목적 및 목표
   - 1.2 설계 범위
   - 1.3 프로젝트 요약
   - 1.4 설계 사양 요약 (Specification Summary)
   - 1.5 AS-IS / TO-BE
2. 프로젝트 관리 (Project Management)
   - 2.1 일정 계획 (Schedule)
   - 2.2 역할 분담 (Roles & Responsibilities)
   - 2.3 개발 환경 (Development Environment)
   - 2.4 사용 도구 (Tools & Models)
3. 시스템 아키텍처 (Architecture)
   - 3.1 전체 시스템 구조
   - 3.2 Event·돌봄 상태 정의
   - 3.3 소프트웨어 계층
   - 3.4 Camera Preview, 상태 처리 (Camera Preview & State Processing)
   - 3.5 Database
4. 상세 설계 (모듈별 AI 모델)
   - 4.1 M-05. 위험 물체 탐지 (Hazard Object Detection)
   - 4.2 M-01. 사람 탐지 (Person Detection)
   - 4.3 M-02. Tracking — 사람 추적
   - 4.4 M-03. Pose Estimation — 자세 추정
   - 4.5 M-04. Temporal Fall Detector — 낙상 감지
   - 4.6 M-06. Daily Summary — 일일 요약
5. 구현 및 통합 검증
   - 5.1 개발·배포·검증 흐름
   - 5.2 통합 후 모델 인식 및 상태 처리 — 이슈 해결 기록
   - 5.3 검증 결과 요약
6. 결과 분석 및 트러블슈팅
   - 6.1 통합 검증에서 확인된 핵심 원인
   - 6.2 개선 방안 (모듈별 남은 개선점)
   - 6.3 플랫폼 차원의 개선 방안
7. 결론 및 고찰
- 참고 문헌

## 1. 개요 (Overview)

### 1.1 목적 및 목표

이 프로젝트의 목적은 보호자가 외출하거나 잠시 자리를 비운 돌봄 공백 시간에도, USB 카메라와 엣지 디바이스만으로 돌봄 대상자의 낙상·장시간 정지·위험물 근접 같은 확인이 필요한 위험 상황을 자동으로 감지하고, 그 상황을 사건과 증거 자료로 정리해 보호자에게 보여주는 가정용 온디바이스 AI 안전 모니터링 플랫폼 Wardy를 구현하는 것이다.

최종 목표는 사람 탐지, 익명 추적, 자세 추정, 시간적 낙상 감지, 위험물 탐지, 일일 요약이라는 여섯 개의 AI 모듈(M-01~M-06)을 하나의 Jetson Edge 파이프라인으로 통합하고, 그 결과를 브라우저 UI에서 실시간 영상·이벤트·돌봄 상태로 확인할 수 있게 만드는 것이다. 클라우드로 영상을 전송하지 않고 엣지 디바이스 내부에서 추론과 저장을 완결하는 것도 핵심 목표에 포함된다.

### 1.2 설계 범위

설계 범위에는 Jetson Orin Nano 위에서 동작하는 C++ Edge Service와 Python 추론 Runtime의 파이프라인 구조, M-01 사람 탐지·M-02 익명 추적·M-03 자세 추정·M-04 시간적 낙상 감지·M-05 위험물 탐지·M-06 로컬 LLM 기반 일일 요약의 여섯 AI 모듈, 이벤트·돌봄 상태 계약과 SQLite 저장, HTTPS·WebRTC 기반 브라우저 UI 연동이 포함된다.

여러 카메라 연동, 외부 알림 연동, 클라우드 기반 원격 접근, 장시간 무인 운용에 대한 완전한 안정성 검증은 이번 산출물 범위에서 제외했다. 이 항목들은 마무리 발표에서 향후 개선 방향으로 명시했다.

### 1.3 프로젝트 요약

Wardy는 일반 가정에서 보호자가 자리를 비운 동안 반복적으로 발생하는 "돌봄 공백 시간의 위험 상황을 누가, 어떻게 확인할 것인가"라는 질문에서 출발한 프로젝트다. 일반 CCTV는 영상만 보여줄 뿐 위험 상황의 판단·기록·확인을 여전히 보호자가 직접 수행해야 하고, 낙상은 짧은 순간에 발생해 대상자의 자세가 바뀌면 그 순간을 놓치기 쉬우며, 가위·칼 같은 위험물 사용 여부를 영상만으로 즉시 판단하기도 어렵다는 문제의식을 기반으로, USB 카메라와 엣지 디바이스를 이용해 돌봄 대상자의 안전 상황을 감지하고 보호자가 확인할 수 있는 사건과 증거 자료로 정리하는 시스템을 설계했다.

최종 파이프라인은 C++ Edge Service가 카메라 프레임을 받아 TensorRT 기반 M-01 사람 탐지를 실행하고, 그 결과를 Unix domain socket을 통해 Python pose_fall_worker로 전달하면 M-02 익명 추적이 track_id를 부여하고, M-03 자세 추정과 M-04 시간적 낙상 감지가 이어서 실행되는 구조다. 동일한 C++ Edge Service의 별도 경로에서 M-05 위험물 탐지가 실행되어 사람 위치와 위험물 위치를 비교해 근접 이벤트를 만들고, 하루 동안 누적된 이벤트는 M-06이 로컬 LLM으로 요약해 사용자에게 전달한다. 핵심 키워드는 온디바이스 추론, 익명 track_id 기반 추적, 시간적 자세 시퀀스 기반 낙상 판단, 위험물 근접 이벤트, 로컬 LLM 일일 요약이다.

### 1.4 설계 사양 요약 (Specification Summary)

| 항목 | 내용 |
|---|---|
| 엣지 디바이스 | NVIDIA Jetson Orin Nano (aarch64), Ubuntu 22.04.5 LTS, JetPack 6.2.2 |
| 영상 입력 | USB Webcam (Logitech C270 등), V4L2, GStreamer |
| M-01 사람 탐지 | YOLO11n, TensorRT 추론, 단일 person class |
| M-02 사람 추적 | Kalman Filter + IoU Gate + Hungarian Matching (SORT 계열), 익명 track_id |
| M-03 자세 추정 | OpenMMLab RTMPose-M, COCO-17 keypoints, 기하 규칙 기반 자세 분류 |
| M-04 낙상 감지 | TemporalFallGRU(단방향 GRU) + standing→lying Fast Path 규칙 |
| M-05 위험물 탐지 | YOLO11n, Scissors/Knife/Cutter/Syringe 4 class |
| M-06 일일 요약 | Ollama 기반 로컬 LLM, Qwen3.5:4b, JSON Schema 검증 + Deterministic Fallback |
| 저장·통신 | SQLite 이벤트 저장, HTTPS API·WebSocket·WebRTC(WHEP), Caddy 게이트웨이 |
| 웹 UI | Vite, TypeScript, HTML/CSS 기반 브라우저 UI |

### 1.5 AS-IS / TO-BE

| 구분 | AS-IS (기존 방식의 한계) | TO-BE (Wardy) |
|---|---|---|
| 확인 방식 | 일반 CCTV는 영상만 제공, 위험 상황의 판단·기록·확인을 보호자가 직접 수행해야 함 | 온디바이스 AI가 위험 상황을 자동으로 감지하고 사건·증거로 정리해 제시 |
| 실시간성 | 낙상처럼 짧은 순간 발생하는 상황은 보호자가 실시간으로 계속 지켜보지 않으면 놓치기 쉬움 | M-01~M-04가 사람 탐지→추적→자세→시간적 낙상 판단을 실시간으로 연쇄 처리해 낙상 의심 이벤트를 즉시 생성 |
| 조작·착용 부담 | 웨어러블·비상 버튼 방식은 즉시 호출은 가능하지만 착용·조작이 필요 | 카메라 기반으로 별도 착용·조작 없이 상시 모니터링 |
| 개인정보·지연 | 클라우드 AI 카메라는 자동 분석이 가능하지만 네트워크 지연과 개인정보 전송 부담이 있음 | 엣지 디바이스 내부에서 영상 추론과 LLM 요약까지 완결해 영상·기록을 외부로 전송하지 않음 |
| 위험물 판단 | 가위·칼 같은 위험물 사용에 대한 판단이 보호자의 영상 확인에 의존 | M-05가 위험물을 실시간으로 탐지하고 사람과의 근접 여부에 따라 주의·경고 단계를 구분해 이벤트로 기록 |

CDC와 WHO의 고령자 낙상 통계는 65세 이상 성인 약 4명 중 1명이 매년 낙상을 경험하고, 고령자가 낙상으로 사망하거나 중상을 입을 위험이 나이에 따라 증가한다는 점을 보여주며, 치매 노인의 낙상 위험 요인 연구는 치매 노인이 인지적으로 건강한 노인보다 더 자주 낙상하고 균형·보행·시각·기능 상태·약물·치매 중증도가 복합적으로 관련된다고 정리한다. 이 통계는 돌봄 공백 시간의 위험 상황을 자동으로 확인해야 하는 이유를 뒷받침하는 배경 근거로 사용했다.

## 2. 프로젝트 관리 (Project Management)

### 2.1 일정 계획 (Schedule)

| 단계 | 기간 | 주요 작업 |
|---|---|---|
| 요구사항 정리 | 08-05 | P0 범위·역할 분담 확정, M-01~M-06 기능요구사항 정리, 산출물 구조 정리 |
| 설계 및 명세화 | 08-05~08-09 | 시스템 아키텍처 설계, M-05/M-01 데이터셋 후보 조사, AI 평가·시연 시나리오(S-01~S-07) 설계 |
| 구현 | 08-07~08-13 | M-05 fine-tuning 및 관리물품 Filter 구현, M-01 데이터셋 병합·학습, M-02~M-04 모델 구현 및 Edge 연동 |
| 검증 | 08-10~08-14 | M-05 모델 버전 비교, M-01 TensorRT export 검증, M-02~M-04 통합 검증(threshold·latch 안정화), M-05 Edge 연동 시연 증거 확보, M-01 리뷰 반영 |
| 발표 및 산출물 정리 | 08-13~08-19 | M-06 구현 및 전체 시스템 통합, 완료보고서·발표자료 총괄 구성, 모듈별 발표자료 정리 |
| 최종 제출 | 08-19 | PPTX·DOCX·XLSX·소스코드 ZIP 파일 정상 여부 확인 |

08-13부터 08-18까지는 개별 모델 구현을 넘어 통합 파이프라인에서 실제로 발생한 인식·상태 처리 문제를 순차적으로 확인하고 수정하는 통합 검증 기간으로 이어졌으며, 그 세부 내용은 5장에서 다룬다.

### 2.2 역할 분담 (Roles & Responsibilities)

| 팀원 | 역할 | 담당 업무 |
|---|---|---|
| 김연우 | 낙상 판단·통합 | 전체 아키텍처와 Event·돌봄 상태 계약 설계, M-02 익명 추적·M-03 자세 추정·M-04 시간적 낙상 감지 구현, M-06 일일 요약 구현과 전체 시스템 통합, 통합 검증 기간의 인식·상태 처리 문제 해결 |
| 박지원 | 위험물 탐지 | AI 모델 기능요구사항 정리, M-05 위험물 탐지 데이터셋 구성과 YOLO11 fine-tuning(v1~v3), 관리 물품 Filter 및 근접 판단 정책 구현, C270 Edge 연동과 시연 증거 확보 |
| 조정민 | 사람 탐지 | 산출물 구조 정리, AI 평가·시연 시나리오 설계, M-01 사람 탐지 데이터셋 병합과 YOLO11 학습, ONNX→TensorRT export 검증과 Jetson 배포 재현성 확인, 리뷰 반영 및 결과 정리 |

### 2.3 개발 환경 (Development Environment)

**Jetson (엣지 디바이스, 추론·저장·API 서버)**

| 항목 | 개발 환경 및 설정 |
|---|---|
| 하드웨어·아키텍처 | NVIDIA Jetson Orin Nano · aarch64 |
| 운영체제·커널 | Ubuntu 22.04.5 LTS · JetPack SDK 6.2.2 · Jetson Linux/L4T R36.5.0 · Linux 5.15.185-tegra |
| GPU 추론 환경 | CUDA Toolkit 12.6.11 · cuDNN 9.3.0.75 · TensorRT 10.3.0 |
| C++ 빌드 환경 | CMake 4.4.2 · GCC/G++ 11.4.0 · pkg-config 0.29.2 |
| C++ 런타임 라이브러리 | OpenCV 4.8.0 · SQLite 3.37.2 |
| Python 추론 환경 | Python 3.10.12 · NumPy 1.26.4 · ONNX Runtime 1.23.2 · SciPy 1.15.3 · Python OpenCV 4.5.4 |
| 카메라·영상 환경 | V4L2 utilities 1.22.1 · GStreamer 1.20.3 |
| 게이트웨이·미디어 서버 | Caddy 2.11.3 · MediaMTX 1.18.2 |
| 로컬 LLM 환경 | Ollama 0.32.5 · Qwen qwen3.5:4b |
| 시스템·보안 도구 | systemd 249 · OpenSSL 3.0.2 · curl 7.81.0 · Git 2.34.1 |
| 담당 역할 | USB Webcam 입력, 온디바이스 AI 추론, 객체 추적·자세·낙상 분석, 이벤트 처리, SQLite 저장, 로컬 LLM 실행, HTTPS API·WebRTC 제공 |
| 시작 방법 | ./start_jetson.sh — 최초 실행 시 의존성·모델·TensorRT 엔진·TLS 인증서·systemd 서비스를 설치하고, 이후 실행에서는 CMake 재빌드와 서비스 재시작 수행 |
| 주요 프로세스 | C++ wardy_edge_service, Python pose_fall_worker.py, GStreamer, MediaMTX, Caddy, Ollama |
| systemd 서비스 | wardy-edge.service, wardy-pose-fall.service, ollama.service, wardy-data-maintenance.timer |
| 내부 통신 | TCP 8443: HTTPS API·WebSocket·WebRTC WHEP signaling · TCP/UDP 8189: WebRTC ICE media · TCP 22: SSH 유지보수 |
| 내부 전용 포트 | Edge API 8787, RTSP 8554, WebRTC HTTP 8889는 loopback에만 바인딩하고 Caddy·MediaMTX 내부 연결에만 사용 |
| 접근 제어 | Caddy가 사설망 외부 요청을 403 Forbidden으로 차단하고, 등록된 UI Origin과 허용된 내부망 UI Origin만 CORS 허용 |
| 방화벽 정책 | 설치 스크립트가 UFW 규칙을 직접 변경하지 않으며, 내부망에서 TCP 8443, TCP/UDP 8189, 유지보수용 TCP 22가 도달하도록 호스트·공유기 방화벽을 확인 |
| TLS·인증 | Wardy 로컬 CA와 Jetson 서버 인증서를 /etc/wardy/tls에 저장하고 Caddy에서 TLS를 종료하며, API·WebSocket용 내부 접근 토큰은 엣지 디바이스 내부에서만 사용 |

**Windows (UI 개발·확인용 클라이언트)**

| 항목 | 개발 환경 및 설정 |
|---|---|
| 운영체제·아키텍처 | Microsoft Windows 11 Pro 10.0.26200 · x64/AMD64 |
| 셸 환경 | PowerShell 7.6.4 · Windows PowerShell 5.1.26100.8115 |
| 소스·원격 도구 | Git for Windows 2.53.0.windows.2 · OpenSSH for Windows 9.5p2 · LibreSSL 3.8.2 |
| 브라우저 | Google Chrome 151.0.7922.138 |
| 프런트엔드 버전 | Vite 7.3.6 · TypeScript 5.9.3 · tsx 4.23.9 · Node.js 26.4.0 · npm 11.17.0 |
| 담당 역할 | Vite UI 개발 서버 실행, 브라우저 화면 렌더링, Jetson API·이벤트·WebRTC 영상 확인 |
| 시작 방법 | .\start_windows.ps1 — 최초 실행 시 npm ci, Jetson CA 인증서 복사·설치, 연결 점검 수행 후 Vite UI 실행 |
| UI 접속 | 기본 http://localhost:8000. AI 추론과 카메라 처리는 Windows가 아닌 Jetson에서 수행 |
| 인증서 신뢰 | Jetson의 공개 CA 인증서만 가져와 certutil -addstore -f Root로 Windows 신뢰 루트 저장소에 등록 |
| 내부 통신 | Jetson TCP 8443으로 HTTPS API·WebSocket·WHEP signaling 연결, TCP/UDP 8189로 WebRTC 영상 수신 |
| 방화벽 정책 | 시작 스크립트가 방화벽 규칙을 직접 변경하지 않으며, 내부망으로 나가는 TCP 8443·TCP/UDP 8189 허용을 확인하고 UI를 다른 기기에 공개할 때만 TCP 8000 인바운드 허용이 필요 |
| 연결 점검 | Test-NetConnection 내부망주소 -Port 8443, edge\scripts\test_windows_connection.ps1로 health·운영 API·WHEP signaling 확인 |
| 원격 서비스 점검 | SSH로 Jetson에 접속해 systemctl status wardy-edge.service wardy-pose-fall.service 확인 |

**macOS (UI 개발·확인용 클라이언트)**

| 항목 | 개발 환경 및 설정 |
|---|---|
| 운영체제·아키텍처 | macOS 26.5.2 · Build 25F84 · Apple Silicon arm64 |
| 셸·소스 도구 | zsh 5.9 · Apple Git 2.50.1 · OpenSSH 10.2p1 · LibreSSL 3.3.6 |
| 프런트엔드 실행 환경 | Node.js 26.4.0 · npm 11.17.0 · Vite 7.3.6 · TypeScript 5.9.3 · tsx 4.23.9 |
| 인증서·개발 도구 | OpenSSL 3.6.3 · Python 3.14.7 · CMake 4.3.0 · macOS Keychain 도구 |
| 브라우저 | Google Chrome 151.0.7922.138 |
| 담당 역할 | Vite UI 개발 서버 실행, 브라우저 화면 렌더링, Jetson API·이벤트·WebRTC 영상 확인, 같은 내부망의 휴대전화에 Wardy UI 제공 |
| 시작 방법 | ./start_macos.sh — 최초 실행 시 npm ci, Jetson CA 신뢰 등록, macOS용 로컬 UI CA·HTTPS 인증서 생성 후 Vite UI 실행 |
| UI 접속 | Mac과 휴대전화에서 https://Mac내부망주소:8000 사용. Jetson 주소는 .wardy-device에 저장해 다음 실행부터 재사용 |
| 인증서 신뢰 | Jetson CA는 System Keychain, Mac UI용 로컬 CA는 Login Keychain에 등록하고, 휴대전화에서는 Mac UI·Jetson 인증서를 최초 1회 신뢰 설정 |
| 내부 통신 | Jetson TCP 8443/TCP·UDP 8189 연결, 휴대전화는 Mac TCP 8000으로 UI 접속 |
| 우회 연결 | Jetson 직접 연결이 불가능하면 SSH 별칭 터널과 macOS loopback alias를 준비해 동일한 HTTPS 주소로 연결 |
| 상태 확인 | curl --cacert "$HOME/Library/Application Support/Wardy/wardy-ca.crt" https://내부망주소:8443/api/health |
| 원격 서비스 점검 | ssh Jetson별칭 'systemctl status wardy-edge.service wardy-pose-fall.service' |

### 2.4 사용 도구 (Tools & Models)

| 구분 | 사용 도구·모델 |
|---|---|
| 코드 버전 관리 | GitHub (github.com/mumallaeng/wardy) |
| 조정민 · M-01 사람 탐지 모델 | Hugging Face (jjm15955/wardy-m1-person-detector) |
| 김연우 · M-04 낙상 감지 모델 | Hugging Face (mumallaeng/wardy-m4-fall) |
| 박지원 · M-05 위험물 탐지 모델 | Hugging Face (chocochip119/wardy-m05-hazard-detector) |
| 엣지 디바이스 | NVIDIA Jetson Orin Nano |
| 운영체제·GPU 플랫폼 | Ubuntu 22.04 LTS, JetPack SDK 6.2.2, CUDA 12.6, cuDNN 9.3, TensorRT 10.3 |
| 영상 입력 | USB Webcam, UVC, V4L2 |
| AI 모델 개발 | Python 3.10, Jupyter Notebook, PyTorch, Ultralytics YOLO11n, OpenMMLab MMPose·RTMPose-M, ONNX |
| AI 추론 실행 | C++, OpenCV, ONNX Runtime, TensorRT |
| 영상 전송 | GStreamer, MediaMTX, WebRTC |
| 웹 UI | TypeScript, Vite, HTML, CSS |
| API·보안 통신 | Caddy, HTTPS, TLS |
| 데이터 저장 | SQLite |
| 로컬 LLM | Ollama, Qwen3.5:4b |
| 빌드·테스트 | CMake, CTest, npm, Vitest |
| 서비스 관리 | systemd |
| 문서·다이어그램 | Markdown, Draw.io, PlantUML, Mermaid, DBML |

생성형 AI는 코딩과 리서치 보조 도구로 활용했다. 로컬 CLI로는 OpenAI Codex CLI(GPT-5.6 계열)와 Anthropic Claude Code(Claude Sonnet 5)를 사용했고, 웹 채팅으로는 ChatGPT(GPT-5.6 Pro 모드), Claude(Claude Sonnet 5), Google Gemini(Gemini Flash)를 병행했으며, 발표 자료용 이미지 생성에는 Nano Banana 2(Gemini 3.1 Flash Image)를 사용했다.

## 3. 시스템 아키텍처 (Architecture)

### 3.1 전체 시스템 구조

Wardy는 USB 카메라 영상을 Jetson Orin Nano의 C++ Edge Service가 받아 GStreamer appsink로 프레임을 취득하고, TensorRT 기반 M-01 사람 탐지를 실행한 뒤 그 결과를 Unix domain socket을 통해 Python pose_fall_worker로 전달하는 구조를 중심축으로 한다. Python 쪽 Tracking Runtime이 M-02 익명 추적으로 track_id를 부여하면, 같은 Runtime 안에서 M-03 자세 추정과 M-04 시간적 낙상 감지가 이어서 실행되어 낙상 확률과 낙상 의심 결과를 다시 C++ 서비스로 반환한다.

C++ Edge Service의 별도 경로에서는 M-05 위험물 탐지가 전체 프레임을 대상으로 위험 물체 위치를 찾고, M-01의 사람 위치와 비교해 가까운 경우 위험물 근접 이벤트를 만든다. 이렇게 모인 이벤트와 상태는 SQLite에 저장되고, HTTPS API·WebSocket·WebRTC를 통해 브라우저 UI로 전달되며, 사용자가 일일 요약을 요청하면 M-06이 SQLite 이벤트를 조회해 로컬 Ollama Qwen3.5 모델로 요약을 생성해 반환한다.

### 3.2 Event·돌봄 상태 정의

시스템은 각 AI 모듈의 원시 추론 결과를 공통 이벤트·돌봄 상태 계약으로 정규화한다. 낙상 의심, 장시간 정지, 위험물 근접처럼 확인이 필요한 상황을 이벤트로 정의하고, 그 이벤트들을 종합해 현재 돌봄 대상자의 상태(정상·주의·경고·긴급)를 계산하는 구조로, 이벤트 발생부터 돌봄 상태 갱신까지의 흐름을 하나의 공통 계약으로 관리해 M-01~M-05의 서로 다른 출력을 일관된 방식으로 사용자 화면에 반영한다.

### 3.3 소프트웨어 계층

Wardy의 소프트웨어는 카메라 입력·AI 추론을 담당하는 C++/Python Jetson Edge 계층, 이벤트·상태·저장을 관리하는 서비스 계층, HTTPS·WebRTC로 결과를 전달하는 통신 계층, 이를 화면으로 보여주는 브라우저 UI 계층으로 나뉜다. 계층 사이의 경계를 명확히 두어, 추론 로직 변경이 통신·UI 계층에 영향을 주지 않도록 하고, 반대로 UI 요구사항 변화가 추론 파이프라인 구조를 흔들지 않도록 설계했다.

### 3.4 Camera Preview, 상태 처리 (Camera Preview & State Processing)

브라우저 UI는 WebRTC(WHEP) 기반으로 Jetson의 실시간 카메라 영상을 미리보기로 제공하고, 그 위에 M-01~M-05의 추론 결과(사람 box, 자세, 낙상 의심, 위험물)를 오버레이로 함께 표시한다. 상태 처리 계층은 여러 모듈에서 동시에 들어오는 이벤트를 하나의 돌봄 상태로 병합·확인·해제하는 규칙을 담당하며, 이벤트가 발생하면 심각도에 따라 상태를 갱신하고 사용자가 확인하거나 오탐으로 처리할 때까지 상태를 유지한다.

Wardy는 이벤트·상태·증거 자료·모델 데이터셋을 하나의 SQLite Database로 일원화해 관리한다. 스키마는 역할에 따라 크게 네 그룹으로 나뉜다. 첫째, events와 system_state는 각 모듈이 생성한 원시 이벤트(occurred_at, event_type, object_class, care_status 등)와 현재 돌봄 상태(care_state, latch 여부)를 기록해 UI 이벤트 로그와 M-06 일일 요약의 입력으로 사용된다. 둘째, scenes와 media_collection_settings, notification_settings는 증거 사진·영상의 저장 경로와 보관 정책(원본·구간 캡처, 보관 기간, 알림 조건)을 관리해 저장 용량과 개인정보 보관 기간을 통제한다. 셋째, dataset_samples·tracking_samples·subject_reference_samples·identity_reviews는 M-01~M-05 재학습과 신원 검수에 쓰이는 학습·검증 샘플과 검수 이력을 저장해, 운영 중 수집된 데이터를 다음 모델 개선 사이클에 재사용할 수 있게 한다. 넷째, subjects·managed_terms·schema_metadata는 등록된 돌봄 대상자, 관리 용어(class·상태 명칭) 사전, 스키마 버전 정보를 보관해 여러 모듈이 공통된 용어와 스키마로 데이터를 주고받도록 한다. 모든 테이블은 UTC 기준 타임스탬프(created_at/updated_at)를 공통으로 두어 이벤트 발생 순서와 상태 변화 이력을 시간순으로 재구성할 수 있도록 설계했다.

### 3.5 Database

이벤트·상태·증거 자료·모델 데이터셋을 위 네 그룹 스키마로 일원화한 SQLite Database 구조이다.

## 4. 상세 설계 (모듈별 AI 모델)

### 4.1 M-05. 위험 물체 탐지 (Hazard Object Detection)

#### 4.1.1 목적과 구조

가정 내 위험 상황 판단을 위해, Python pose_fall_worker의 별도 위험물 탐지 경로가 전체 프레임에서 위험물 위치를 찾고, C++ Edge Service가 M-01의 사람 위치와 비교해 가까운 경우 위험물 근접 이벤트를 생성한다. 대상 클래스는 Scissors, Knife, Cutter, Syringe 4종이며, 검출 기능은 실시간 카메라 영상에서 위험 물체의 위치와 클래스를 찾는 것이고, 운영 환경은 Jetson과 Logitech C270 기반 On-Device 실시간 추론이다. 가위·커터칼·주사기는 실환경 검증까지 완료했고, Knife는 실물 데이터 확보가 추가 과제로 남았다.

#### 4.1.2 Dataset 수집 및 전처리

공개 Dataset에서 위험 물체 이미지를 수집하고, Scissor·Knife·Cutter·Syringe 4개 Class를 YOLO 형식으로 통합해 학습 Dataset을 구성했다. 절차는 (1) 공개 Dataset에서 위험 물체 이미지 수집, (2) 이미지·라벨 형식을 YOLO 형식으로 통일, (3) 4개 Class로 정리, (4) Train/Validation/Test 데이터로 분할하는 순서로 진행했다.

| Class | Image 수 |
|---|---|
| Scissor | 2,000 |
| Knife | 1,564 |
| Cutter | 1,010 |
| Syringe | 1,197 |
| Total | 5,771 |

Train 4,623장, Validation 579장, Test 569장으로 분할했다.

#### 4.1.3 초기 모델 학습

YOLO11n 기반으로 학습 조건을 설정하고, Smoke Test(5 epoch)로 Dataset·Label·학습환경을 확인한 뒤 100 Epoch 본 학습을 수행하고 Test Set으로 평가해 best.pt를 선정하는 순서로 진행했다.

| 항목 | 설정 |
|---|---|
| Model | YOLO11n |
| Image Size | 640 x 640 |
| Batch Size | 16 |
| Smoke Test | 5 epoch |
| Full Training | 100 epoch |
| Class | 4 |

초기 모델(V1)의 성능은 mAP@0.5 83.1%, mAP@0.5:0.95 61.1%였다. 클래스별 성능 차이가 확인되어 이후 Fine-tuning을 진행하기로 했다.

#### 4.1.4 Fine-tuning 실험 및 모델 개선

초기 모델의 클래스별 성능 차이를 보완하기 위해 데이터 보강과 Augmentation 조건을 바꿔가며 Fine-tuning을 반복 수행했다.

| Model | 주요 변경 사항 | mAP@0.5:0.95 | 판단 |
|---|---|---|---|
| V1 | 초기 학습 | 61.1% | 기준 |
| V2 | 데이터 보강(Knife·Negative) | 61.5% | 선정 |
| V3 | Rotation 30° | 56.4% | 감소 |
| V4 | Rotation 15° | 56.8% | 감소 |
| V2+20 | V2에서 20 epoch 추가 | 58.2% | 감소 |

Rotation 증강을 적용하면 Test 성능이 오히려 감소했고, V2에서 epoch을 더 늘려도 성능 개선은 없었다. 이를 근거로 V2 best.pt를 최종 판단으로 선정해 이후 C270 Fine-tuning의 Base Model로 사용했으며, 추가 학습보다 데이터 구성과 증강 조건이 Test 일반화 성능에 더 큰 영향을 준다는 결론을 얻었다.

#### 4.1.5 C270 실환경 문제 확인 및 추가 데이터 구성

선정한 V2 best.pt를 실제 C270 웹캠에 적용한 결과, 기존 Test Set에서는 확인하기 어려웠던 거리·각도·배경 변화와 오탐 패턴이 실제 웹캠에서 드러났다. Scissors는 근거리에서는 비교적 안정적으로 검출됐지만, Knife는 대부분의 실환경 조건에서 미검출됐고, Cutter·Syringe는 정면·근거리 조건에서 주로 검출됐다. 또한 펜·일반 객체를 Scissors로 오인식하는 False Positive도 확인됐다.

이 도메인 차이를 보완하기 위해 C270 실사 데이터 총 102장(Scissors 38장, Cutter 30장, Negative 34장)을 추가로 구성했다. Knife와 Syringe의 실사 데이터는 이번 추가 구성에는 포함하지 못했다.

#### 4.1.6 C270 Fine-tuning

V2 best.pt를 Base Model로 사용하고 C270 실사 데이터를 추가해 실제 웹캠 환경에 맞게 Fine-tuning을 수행했다. Fine-tuning 전략은 기존 Test 성능이 가장 안정적이었던 V2 best.pt에서 시작하는 Base Model 재사용, 실제 웹캠에서 발생한 거리·각도·배경 차이를 학습에 반영하는 C270 실사 데이터 추가, 이전 Rotation 실험에서 Test 성능이 감소했던 것을 반영해 회전 증강을 적용하지 않는 것, 장시간 재학습보다 C270 환경 적응 여부 확인에 집중하는 짧은 추가 학습이었다.

| 항목 | 설정 |
|---|---|
| Base Model | V2 best.pt |
| epoch | 20 |
| Image Size | 640 x 640 |
| Batch Size | 16 |
| Rotation | 0° |
| Patience | 10 |
| Device | GPU |

학습 결과 Validation 성능이 가장 좋은 V2 best.pt를 최종 모델로 사용하기로 했다.

#### 4.1.7 최종 모델 성능 평가

C270 Fine-tuning 후 기존 Test Set을 기준으로 최종 best.pt의 탐지 성능을 평가했다. mAP@0.5는 83.5%, mAP@0.5:0.95는 63.8%였다. Confusion Matrix와 Precision–Recall Curve를 함께 확인한 결과, Test Set에서는 Cutter·Syringe가 높은 성능을 보였고 Knife는 상대적으로 낮은 성능을 확인했다.

#### 4.1.8 Jetson + C270 실환경 적용 결과

최종 best.pt를 Jetson에 적용하고 Logitech C270 웹캠 영상에서 실제 위험 물체 검출 성능을 확인했다. 검증 범위는 Scissors, Cutter, Syringe였으며 Knife는 실환경 검증을 진행하지 못했다. 종합적으로 가위는 비교적 안정적으로 검출됐으나, 커터칼과 주사기는 거리·각도에 따른 성능 편차가 확인됐다.

#### 4.1.9 한계 및 개선 방향

실제 C270 테스트에서 확인된 미검출·오탐 사례를 기반으로 추가 데이터 수집과 모델 개선 방향을 정리했다. 최종 목표는 C270 실환경 데이터 보강을 통해 오탐을 줄이고 거리·각도 변화에 대한 일반화 성능을 개선하는 것이다.

| 현재 한계 | 개선 방향 |
|---|---|
| Scissor 편향으로 일반 객체를 오인식 | Hard Negative 보강 — 펜·도구류 데이터 추가 |
| Knife 검출 부족 — 실제 환경에서 대부분 미검출 | Knife 실사 데이터 확보 — 거리·각도·가림 다양화 |
| Cutter/Syringe 일반화 부족 — 거리·각도 변화에 민감 | Cutter Hard Case 보강 — 앞·뒤·측면·원거리 데이터 추가 |

### 4.2 M-01. 사람 탐지 (Person Detection)

#### 4.2.1 목적과 구조

C++ Edge Service가 GStreamer appsink로 카메라 프레임을 받아 TensorRT 기반 YOLO11n을 실행해 사람을 탐지한다. 낙상 감지와 자세 분석을 위해서는 다양한 환경과 자세에서도 사람을 안정적으로 검출할 수 있어야 하므로, 이를 목표로 Person Detection 모델을 학습했다. 목표는 여러 사람을 서로 다른 거리에서 안정적으로 탐지하는 것, 서 있거나 앉아 있는 등 다양한 자세에서 정확히 탐지하는 것, 실제 홈캠 환경에서도 사람을 안정적으로 탐지하는 것이다.

#### 4.2.2 Dataset 수집 및 전처리

Roboflow Universe에서 Person Dataset을 수집하고 YOLO 형식으로 변환한 뒤, 모든 사람 객체를 단일 person class로 설정했다. 절차는 (1) Roboflow Universe에서 Person Dataset 수집, (2) 이미지·라벨 형식을 YOLO 형식으로 통일, (3) 모든 사람 객체를 단일 class person으로 통합, (4) Train/Validation/Test 데이터로 분할하는 순서였다.

#### 4.2.3 모델 및 학습 방법

Smoke Test로 Dataset과 학습 환경을 검증한 후, 설정한 학습 조건을 기반으로 YOLO11n 50 Epoch 본 학습을 수행했다. 학습 과정은 Smoke Test(Dataset·학습 환경 정상 동작 확인) → Full Training(50 Epoch 본 학습) → Model Evaluation(Precision, Recall, mAP 기반 성능 평가) 순서였고, Full Training 설정은 Model YOLO11n, Image Size 640×640, Batch Size 16, Epoch 50이었다.

#### 4.2.4 Full Training 학습 결과

50 epoch 동안의 학습 과정을 통해 모델의 수렴 특성과 주요 성능 지표를 확인했다. Training/Validation Loss가 함께 감소하고 Precision, Recall, mAP가 증가해 50 epoch 동안 안정적으로 학습됨을 확인했다.

| 지표 | 값 |
|---|---|
| Precision | 0.925 |
| Recall | 0.869 |
| mAP50 | 0.945 |
| mAP50-95 | 0.758 |

#### 4.2.5 Full Training 성능 분석

Precision-Recall Curve와 Confusion Matrix를 통해 정량 성능을 분석했다. 정량 평가에서는 높은 Person Detection 성능을 확보했지만, 일부 오탐과 미검출 사례도 존재했다.

#### 4.2.6 Test Set Detection 결과

학습에 사용하지 않은 Test Set에 최종 모델을 적용해 Person bbox와 confidence 출력 결과를 확인했다. Test Set 적용 결과, 학습되지 않은 다양한 장면에서도 전반적으로 안정적인 사람 검출 성능을 확인했다.

#### 4.2.7 Jetson Board 적용 결과 — 정상 검출 사례

Jetson Board 환경에서 실시간 Person Detection이 정상적으로 동작함을 확인했다. 실제 보드 환경에서 여러 사람을 동시에 검출할 수 있었으며, 다양한 거리와 위치에서도 Person Detection 결과가 정상적으로 표시됐다.

#### 4.2.8 Jetson Board 적용 결과 — 한계 사례

전반적으로 안정적인 검출 성능을 확인했으나, 일부 환경에서는 False Positive와 부분 검출 사례가 발생했다. 배경·가림·촬영 각도 등의 영향을 분석해 추가 Fine-tuning 방향을 도출했다.

#### 4.2.9 부족한 점 및 보완 방향

보드 적용 결과를 바탕으로 실제 환경 대응을 위한 추가 학습 방향을 정리했다. 최종 목표는 실제 생활 공간에서 사람을 안정적으로 검출해 후속 Fall Detection 입력 신뢰도를 향상하는 것이다.

| 현재 부족한 점 | 보완 계획 |
|---|---|
| 컵 손잡이·의자·가방 등 사람과 유사한 형태의 물체에서 false positive 발생 | Roboflow Universe 기반 Dataset에 실제 원룸·부엌·침대 주변 장면 추가 |
| 화면 가장자리나 부분 가림 상황에서 bbox가 사람 일부만 잡히는 경우 발생 | Hard Negative Image를 추가해 사람이 아닌 물체 오검출 감소 |
| 학습 Dataset과 실제 보드 카메라 시점 사이의 차이가 존재 | 고령자 자세와 홈캠 시점 데이터를 보강해 Wardy 환경에 맞게 fine-tuning, Jetson 실시간 테스트를 반복해 Threshold와 후처리 조건 조정 |

### 4.3 M-02. Tracking — 사람 추적

#### 4.3.1 목적과 구조

C++ PoseFallClient가 프레임과 M-01 탐지 결과를 JSON으로 직렬화해 Unix domain socket으로 Python pose_fall_worker에 보내면, worker 내부의 Tracking Runtime이 사람별 track_id를 생성하고 유지한다. M-03·M-04가 한 사람의 자세를 몇 초간 이어 붙여 분석해야 하므로, 프레임 사이를 연결하는 임시 track_id가 필요하다.

#### 4.3.2 알고리즘 선택: SORT와 MLP 비교

Tracking 분야의 고전적인 baseline 기법인 SORT(Simple Online and Realtime Tracking)의 Kalman Filter + IoU Gate + Hungarian Matching 조합을 기본으로 사용하고, 추가로 개선해보기 위해 motion feature 기반으로 학습된 MLP(Multi-Layer Perceptron)도 함께 적용해 비교했다.

#### 4.3.3 추적 처리 과정 (Process)

입력은 frame과 bbox 위치·score이고, 출력은 anonymous track_id다. 처리 과정은 다음 단계로 이어진다.

- **Kalman Filter**: 누적된 과거 frame의 정보로 현재 bbox 위치를 예측한다. Noise가 포함된 측정값과의 noise를 최대한 제거(filtering)하면서 현재 상태를 찾아내는 최적 추정 알고리즘이다.
- **후보 제한 1. IoU(Intersection over Union)**: 예측 bbox와 새 detection bbox가 얼마나 겹치는지 계산해 매칭 비용과 게이트(매칭 후보 인정 여부)의 핵심 재료로 사용한다. 두 영역의 교집합을 합집합으로 나눈 값(0~1)으로, 두 박스가 같은 물체를 가리키는지 재는 객체 탐지·추적 분야의 표준 유사도 지표다.
- **후보 제한 2. MLP(Multi-Layer Perceptron)**: IoU·중심 이동량·크기 변화 같은 motion feature를 입력받아, 두 bbox가 같은 사람인지 여부를 매칭 비용으로 직접 산출한다. 입출력 관계를 사람이 수식으로 고정하는 대신, 여러 층의 선형 변환과 비선형 활성화 함수를 데이터로 학습해 비선형 결정 경계를 근사하는 신경망이다.
- **Hungarian Matching**: track별 예측 bbox와 이번 프레임 detection들 사이의 비용 matrix에서, 실제로 전체 비용 합이 최소가 되는 1:1 매칭 조합을 찾아 연결한다. 비용 matrix가 주어졌을 때 다항 시간 안에 전역 최적의 1:1 할당을 보장하는 조합 최적화(선형 할당 문제) 알고리즘이다.
- **Track Lifetime(min_hits/max_age_frames)**: 매칭 안 된 detection은 새 track_id로 등록하고, 일정 프레임(10) 이상 매칭이 끊긴 track은 소멸시켜 유효한 track 집합을 계속 관리한다. 가려짐(occlusion)으로 인한 일시적 관측 두절은 얼마나 봐줄지, 노이즈성 오탐은 몇 프레임 만에 걸러낼지를 정하는 추적기의 생존 정책 파라미터다.

#### 4.3.4 채택 결과

M-02A(SORT 계열)와 M-02B(MLP 계열)를 IDF1, MOTA, ID switch, 평균 지연시간 네 지표로 비교했다.

| 지표 | M-02A | M-02B | 판단 |
|---|---|---|---|
| IDF1 | 0.7807 | 0.7320 | A 우세 |
| MOTA | 0.9147 | 0.8654 | A 우세 |
| ID switch | 134 | 660 | A 우세 |
| 평균 지연시간 | 2.87 ms/frame | 11.08 ms/frame | A 우세 |

네 지표 모두 M-02A(SORT 계열)가 우세해 M-02A를 최종 Edge 기본 tracker로 채택했다.

### 4.4 M-03. Pose Estimation — 자세 추정

#### 4.4.1 목적과 구조

Python pose_fall_worker의 TrackingPoseFallRuntime이 M-02의 track_id와 사람 영역을 RTMPose-M에 전달하고, 사람별 COCO-17 관절점과 현재 자세를 계산한다. M-04가 동일 인물의 연속적인 자세 변화를 시간축으로 분석할 수 있도록, 사람별 정규화 관절 데이터를 제공하는 것이 M-03의 역할이다.

#### 4.4.2 방법 선택

단일 RGB 영상에서 신체 관절 위치를 추정하는 2D Human Pose Estimation 방식을 채택하고, OpenMMLab MMPose 프레임워크의 RTMPose를 사용해 COCO-17 관절 좌표와 confidence를 추출했다. 관절의 거리·각도·몸통 방향으로 자세 상태(서 있음, 앉아 있음, 누워 있음, unknown)를 계산하고, 관절점 시퀀스와 자세 상태를 M-04에 전달한다.

#### 4.4.3 RTMPose 상세 모델 선택: Tiny에서 Medium으로

On-Device 모델이므로 초기에는 경량인 RTMPose-t(Tiny)를 사용했다. 테스트 데이터로는 파이프라인 자체가 문제없이 검증됐지만, 실물 테스트에서 포즈 출력이 사라지는 상황이 발생했다. 초기 자세 판정 로직은 아래와 같았다.

| 판정 항목 | 계산식 | 결과 |
|---|---|---|
| 입력 유효성 | COCO-17 (17, 3), 양쪽 어깨·골반 confidence 0.30 이상, 몸통 길이 1 px 이상 | 조건 미충족 시 unknown |
| 몸통 축 | 양쪽 어깨 중심에서 양쪽 골반 중심으로 향하는 2D vector torso=(dx,dy) 계산 | 몸통 방향과 길이 계산 |
| 누워 있음 | abs(dx) >= abs(dy) × 0.85 | 참이면 lying으로 판정하고 종료 |
| 하체 가시성 | 좌우 무릎 중 confidence 0.30 이상인 관절만 사용 | 보이는 무릎이 없으면 unknown |
| 앉아 있음 | hip_to_knee_y < torso_length × 0.65 | 참이면 sitting |
| 서 있음 | 위 lying, sitting 조건에 해당하지 않음 | standing |

이 문제를 해결하기 위해 더 정확한 모델인 RTMPose-M(Medium)으로 변경하고, 관절이 일부만 잡힌 불완전한 결과는 제외하도록 했다. 자세 분류 로직도 실물 테스트를 진행하며 아래처럼 더 구체화했다.

| 판정 항목 | 수정 후 계산식 | 결과 |
|---|---|---|
| 입력 유효성 | COCO-17 (17, 3), 양쪽 어깨·골반 confidence 0.30 이상, 몸통 길이 1 px 이상 | 수정 전과 동일하게 조건 미충족 시 unknown |
| 몸통 축 | 양쪽 어깨 중심에서 양쪽 골반 중심으로 향하는 2D vector torso=(dx,dy) 계산 | 수정 전과 동일하게 몸통 방향과 길이 계산 |
| 누워 있음 | abs(dx) > abs(dy) × 1.20 | 수평에 더 가까운 몸통만 lying으로 판정하고 종료 |
| 하체 가시성 | 무릎 confidence 0.30 기준을 유지하고, 사용 가능한 각 다리의 hip-knee-ankle confidence도 확인 | 보이는 무릎이 없으면 unknown, 완전한 다리가 보이면 무릎 각도 계산 |
| 앉아 있음 | 평균 무릎 각도 145° 미만. 유효 각도가 없거나 145°~155° 구간이면 hip_to_knee_y < torso_length × 0.50 fallback | 조건 충족 시 sitting |
| 서 있음 | 평균 무릎 각도 155° 이상. 각도 판정이 불가능하거나 완충 구간이면 거리 fallback에서 0.50 이상 | 조건 충족 시 standing |

누워 있음 판정의 몸통 각도 기준을 0.85에서 1.20으로 조정해 수평에 더 가까운 몸통만 lying으로 판정하도록 엄격하게 만들었고, 앉음/섬 판정에는 무릎 각도(145°/155° 임계값과 완충 구간)를 새로 도입해 기존의 단순 거리 비율(hip_to_knee_y) 방식을 fallback으로 격하시켰으며, 5-frame 다수결 기반 시간축 안정화를 새로 추가해 프레임 단위로 흔들리던 자세 판정을 완화했다.

#### 4.4.4 자세 추정 처리 과정 (Process)

입력은 frame + person bbox + track_id이고, 출력은 COCO-17 keypoints [x, y, score] + posture다. 처리 과정은 다음과 같다.

- **192×256 Affine Transform(전처리)**: M-01/M-02가 넘긴 원본 bbox에 1.25배 여유를 줘, 관절이 박스 경계에 잘리지 않도록 crop 영역을 넓힌다. 여유를 준 crop 영역을 모델이 요구하는 192×256 고정 크기로 변환하고, BGR→RGB·정규화까지 처리해 모델 입력을 만든다.
- **RTMPose-M(SimCC decode)**: 전처리된 crop 이미지를 입력받아 COCO-17 관절 각각의 (x, y, confidence)를 추론한다. 관절 좌표를 직접 회귀하는 대신 x축·y축 각각을 독립적인 1D 분류(bin) 문제로 풀어, 좌표 회귀보다 안정적인 서브픽셀 정밀도를 얻는 RTMPose 특유의 경량 Top-Down 구조다.
- **Posture Rule(기하 규칙)**: RTMPose가 출력한 17개 관절 좌표만으로 몸통 기울기·무릎 굴곡각을 계산해 standing/sitting/lying/unknown 중 하나로 판별한다. 별도 분류기를 학습하지 않고, 관절 벡터 사이의 각도·비율을 고정 임계값과 비교해 상태를 결정하는 규칙 기반(rule-based) 판별식이다.
- **5-frame Smoothing**: 매 프레임 흔들릴 수 있는 자세 판정을 최근 5개 프레임에 대한 다수결로 묶어, 순간적인 오판정 하나가 그대로 이벤트로 새는 것을 완화한다. 노이즈에 취약한 순간 판정을 시간축에서 다수결(majority vote)로 평활화하는 후처리 기법으로, 별도 학습이 필요 없는 시계열 스무딩 방식이다.

### 4.5 M-04. Temporal Fall Detector — 낙상 감지

#### 4.5.1 목적과 방법 선택

낙상은 본인 의사와 상관없이 미끄러지거나 걸려 넘어져 다치는 현상이다. 일상적인 눕기와 실제 낙상을 구분하려면 동일 인물의 연속적인 자세 변화를 시간축으로 분석해 낙상 여부를 판단하는 Temporal Fall Detection(시간적 낙상 감지)이 필요하다. 짧은 자세 시퀀스의 시간 변화와 실시간 엣지 처리를 고려해 경량 시계열 baseline인 TemporalFallGRU(단방향 GRU)를 선택하고, URFD(UR Fall Detection) 데이터셋에서 추출한 관절 시퀀스로 직접 학습했다. 20 frame(2초) × 80 feature의 관절 시퀀스를 입력받아 낙상 confidence를 계산하며, standing→lying 급전환 Fast Path를 병행하고 M-03 자세와 결합해 낙상 의심 이벤트를 생성한다.

M3와 같은 Python Runtime이 track_id별 관절 데이터를 20프레임 동안 누적하고 TemporalFallGRU와 급격한 자세 전환 규칙을 실행해 낙상 확률과 낙상 의심 결과를 C++ 서비스로 반환한다.

#### 4.5.2 낙상 감지 처리 과정 (Process)

입력은 Track ID별 20프레임 pose 시퀀스(keypoints + posture)이고, 출력은 fall_confidence + fall_suspected + posture다. 처리 과정은 다음과 같다.

- **History Buffering(슬라이딩 윈도우)**: track별로 최근 20프레임(window_frames)의 pose 결과를 deque에 계속 쌓아, 항상 가장 최근 2초를 유지한다. 고정 길이(maxlen)를 넘으면 가장 오래된 항목을 자동으로 밀어내는 순환 버퍼(circular buffer)로, 매 프레임 전체를 다시 계산하지 않고 최신 구간만 유지하는 스트리밍 방식이다.
- **Fast Path 규칙(급전환 감지)**: 직전 두 프레임이 연속 standing이다가 이번 프레임에 lying으로 바뀌면, 윈도우가 다 차길 기다리지 않고 confidence 1.0의 낙상 후보를 즉시 생성한다. 모델 추론 없이 최근 자세 이력 3개(직전 2개+현재)만 비교하는 조건문 기반 예외 처리로, 지연이 치명적인 상황에서 학습 모델을 우회하는 규칙이다.
- **Feature Engineering**: Fast Path가 걸리지 않고 윈도우가 20프레임 모두 찼을 때만 실행되며, 20개의 pose 결과를 관절 좌표·confidence·파생 특징을 포함한 75차원 벡터 시퀀스로 변환한다. 원시 좌표를 모델이 바로 소비할 수 있는 고정 shape의 수치 텐서로 바꾸는 특징 추출(feature extraction) 단계다.
- **정규화(Normalization)**: 학습 시 정해둔 feature별 평균·표준편차로 이 75차원 벡터를 표준화한다. 서로 스케일이 다른 특징들을 평균 0, 분산 1 근처로 맞춰 모델이 특정 특징에 치우치지 않게 하는 z-score 표준화다.
- **TemporalFallGRU 추론**: 정규화된 20프레임 시퀀스를 GRU 모델에 넣어 logit을 얻고, sigmoid를 적용해 0~1 사이의 낙상 confidence로 변환한다. 순환 신경망(GRU)이 시퀀스 전체의 시간적 패턴을 학습된 가중치로 요약해 하나의 스칼라 확률로 압축하는 추론 연산이다.
- **임계값 적용(Threshold)**: confidence가 threshold 이상이면 fall_suspected=True로 최종 판정한다. 이때 threshold는 모델이 제시한 값과 무관하게 60% 밑으로는 절대 내려가지 않도록 코드에 하한선이 고정돼 있다. 연속적인 확률 출력을 이진 결정(낙상/정상)으로 바꾸는 결정 경계(decision threshold)이자, 모델 재학습으로 임계값이 실수로 낮아지는 것을 막는 운영 안전장치다.

이 과정을 종합하면, 얼마나 빠르고 급격하게 자세가 무너졌는지를 급전환 규칙과 시계열 모델 양쪽에서 함께 평가해 낙상 가능성을 계산하는 구조다.

### 4.6 M-06. Daily Summary — 일일 요약

#### 4.6.1 필요성과 설계

하루 동안 누적된 안전 이벤트를 사용자가 일일이 확인하지 않고도 전체 돌봄 상황을 빠르게 파악할 수 있도록 일일 요약 기능이 필요했다. 민감한 돌봄 기록을 외부 서버로 전송하지 않도록 Edge Device 내부의 Ollama 기반 On-device LLM 방식을 채택했고, 자체 테스트로 모델을 비교해 최종적으로 Qwen3.5:4B를 선택했다.

SQLite에 저장된 날짜별 이벤트를 익명화된 텍스트로 변환해 입력으로 사용하고, temperature=0, JSON Schema, 고정 집계 문장 검증을 적용해 출력을 통제했으며, Timeout·모델 오류·부적합한 응답이 발생하면 Deterministic Fallback Summary를 반환하도록 해 LLM이 실패하더라도 사실과 다른 요약이 나가지 않게 했다. 검증된 한국어 일일 요약은 HTTPS API로 전달되어 브라우저 UI의 "오늘 요약"에 표시된다.

사용자가 일일 요약을 요청하면 C++ Edge Service의 DailySummaryService가 SQLite 이벤트를 조회하고, 로컬 Ollama의 Qwen3.5 모델을 호출해 생성한 요약을 HTTPS API로 UI에 반환하는 흐름이다.

## 5. 구현 및 통합 검증

### 5.1 개발·배포·검증 흐름

Wardy는 개별 AI 모듈을 각각 학습·평가한 뒤, Jetson Edge 파이프라인에 통합하고, 통합된 상태에서 실제 카메라·조명·자세 조건으로 다시 검증하는 순서로 개발을 진행했다. 모듈 단위 검증에서 좋은 성능을 보이더라도 통합 이후에는 모듈 간 경계에서 새로운 문제가 나타날 수 있으므로, 통합 후 실물 테스트를 반복하며 문제를 확인하고 수정하는 단계를 별도로 운영했다.

### 5.2 통합 후 모델 인식 및 상태 처리 — 이슈 해결 기록

M-01~M-06을 하나의 파이프라인으로 통합한 이후, 08-13부터 08-18까지 실제 촬영 환경에서 반복적으로 테스트하며 아래 문제들을 순서대로 확인하고 수정했다.

#### 5.2.1 260813 — 인식 실패 원인 파악과 상태 고정 문제

통합 초기에는 인식이 실패해도 어떤 class가 왜 인식되지 않았는지 화면에서 파악할 수 없어, class 정보가 보이도록 디버깅 표시를 추가했다. 상태 화면에서도 대부분의 값이 확인 불가로 표시돼 상태가 잦게 바뀌는 것에 대한 보정이 필요하다는 점이 드러났고, 특히 서 있거나 앉아 있는 상태에서도 돌봄 상태가 긴급으로 고정되거나, 실제로는 서 있는데 앉아 있음으로 오인식하는 사례가 확인됐다.

이어서 확인한 사례에서는 누워 있는 상태를 서 있거나 앉아 있는 상태로 오인식하는 경우가 종종 나타났고, 낙상을 정상적으로 인식하더라도 이후 프레임에서 바로 해제되는 문제가 있었다. 이를 통해 누워 있는 상태가 유지된다면 긴급 상태도 함께 유지되어야 한다는 요구사항을 확인했다.

긴급 상태가 임의로 고정되는 문제를 수정하고, 자세 판정 기준을 보정해 누워 있는 자세를 제대로 인식하도록 개선했다.

#### 5.2.2 260814 — 낙상 미인식과 자세 오탐 보완

누워 있는 자세의 판단 기준을 수정하는 과정에서, 오히려 낙상을 인식하지 못하는 회귀가 발생했다.

이를 해결하기 위해 포즈 판정에 낙상 의심 상태를 추가해, 낙상 의심을 확인하거나 오탐으로 처리하는 판단이 가능하도록 구조를 변경했다.

낙상 판단이 실제로 성공했을 때와 오탐일 때를 구분할 수 있도록 관련 데이터를 계속 쌓아갔다.

특히 낙상과 상체만 보이는 상황에서 오탐이 잦았는데, M-03 자세 오탐이 M-04 낙상 인식까지 이어지지 못하게 만드는 경우가 다수 있었다. 이를 해결하기 위해 오탐 사례와 인식에 성공한 사례의 데이터를 함께 쌓아 M-03 Pose의 판정 기준을 다시 조정했다.

#### 5.2.3 260817 — 낙상 인식 정확도 개선

앞선 수정을 반영한 결과, 낙상 인식 정확도가 향상됐고 의도적으로 누웠을 때와 실제 낙상을 구분할 수 있게 됐다.

#### 5.2.4 260818 — 위험물 근접 이벤트와 UI 동작 확인

위험물이 사람과 멀리 떨어져 있을 때는 주의 단계로, 가까이 있을 때는 경고 단계로 구분되도록 위험물 근접 이벤트를 확인했다.

이벤트 기록, 데이터 작업실, 설정 등 UI의 나머지 동작도 함께 확인했다.

### 5.3 검증 결과 요약

| 항목 | 검증 내용 | 결과 | 달성 여부 |
|---|---|---|---|
| M-01 사람 탐지 | Test Set 및 Jetson Board 실시간 검출 | Precision 0.925, Recall 0.869, mAP50 0.945로 안정적 검출 확인, 일부 유사 형태 오탐 존재 | 달성 |
| M-02 사람 추적 | M-02A/M-02B(SORT vs MLP) 비교 | IDF1·MOTA·ID switch·지연시간 전 지표에서 M-02A 우세, Edge 기본 tracker로 채택 | 달성 |
| M-03 자세 추정 | RTMPose-t/M 비교, 실물 테스트 반복 보정 | RTMPose-M 전환과 임계값·다수결 보정으로 lying 인식 안정화 | 달성 |
| M-04 낙상 감지 | 통합 후 실물 낙상·오탐 사례 반복 검증 | Fast Path + GRU 조합으로 급전환 낙상을 즉시 감지, threshold 60% 하한으로 오탐 억제 | 달성 |
| M-05 위험물 탐지 | Test Set 평가 + Jetson·C270 실환경 적용 | mAP@0.5 83.5%, mAP@0.5:0.95 63.8%, Scissors/Cutter/Syringe 실환경 검출 확인, Knife 미검증 | 달성 |
| M-06 일일 요약 | JSON Schema·집계 문장 검증, Fallback 동작 확인 | 검증된 한국어 요약을 UI에 정상 반환, 오류 시 Deterministic Fallback 정상 동작 | 달성 |
| 통합 UI | 이벤트 기록·데이터 작업실·설정 화면 동작 확인 | 정상 동작 확인(260818) | 달성 |

위 결과는 4장의 모듈별 성능 지표와 5.2의 통합 검증 기록을 종합한 것이며, 남은 한계와 개선 방향은 6장에서 다룬다.

## 6. 결과 분석 및 트러블슈팅

### 6.1 통합 검증에서 확인된 핵심 원인

08-13~08-18 통합 검증 기간에 반복적으로 나타난 문제의 공통 원인은 크게 두 가지로 정리된다. 첫째, M-03 자세 추정의 오탐이 M-04 낙상 인식으로 그대로 전파되는 경계 문제였다. 자세 판정이 흔들리면 그 위에서 동작하는 낙상 감지도 함께 흔들렸기 때문에, 단일 모듈의 정확도 개선만으로는 전체 낙상 인식률이 개선되지 않았다.

둘째, 돌봄 상태(care status)가 한 번 긴급으로 고정되면 이후 프레임에서 자동으로 해제되지 않거나, 반대로 낙상을 인식해도 바로 해제되는 상태 전이 로직의 결함이었다. 이 두 원인은 서로 독립적이지 않았고, 자세 오탐으로 상태가 잘못 바뀐 뒤 상태 전이 로직이 그 오류를 다시 고정하는 방식으로 겹쳐서 나타났다.

### 6.2 개선 방안 (모듈별 남은 개선점)

마무리 시점에 모듈별로 남은 개선 방향을 아래와 같이 정리했다.

| 모듈 | 남은 개선점 |
|---|---|
| M-01 사람 탐지 | 조명 변화와 촬영 거리, 신체 일부 가림에 대한 검출 정확도 보완 |
| M-02 객체 추적 | 복수 인원과 가림 상황에서 발생하는 추적 단절 및 대상 전환 최소화 |
| M-03 자세 추정 | 다양한 카메라 각도에서도 안정적인 자세 분류가 가능하도록 기준 고도화 |
| M-04 낙상 감지 | 천천히 눕는 동작과 실제 낙상을 구분하기 위한 실물 데이터 확보 필요 |
| M-05 위험물 탐지 | 손에 든 다양한 각도·배경의 데이터를 보강해 실물 인식률 향상 |
| M-06 일일 요약 | 이벤트 사실성을 유지하면서 문장의 자연스러움을 높이는 방향으로 발전 |

### 6.3 플랫폼 차원의 개선 방안

플랫폼 차원에서는 장시간 운용 성능과 네트워크 재연결 안정성에 대한 추가 검증이 필요하고, 인증서 설정과 서비스 복구 과정을 간소화하는 초기 설정 자동화 도입, 모델 업데이트와 이전 버전 복구를 지원하는 배포 관리 체계 구축, 향후 멀티 카메라 연동과 외부 알림 기능으로의 서비스 범위 확장이 다음 단계 과제로 남았다.

프로토타입 수준을 넘어 실제 환경에서의 안정성을 개선하는 것이 이후 방향이다.

## 7. 결론 및 고찰

카메라 입력부터 AI 추론, 이벤트 판단, 사용자 확인, 일일 요약까지 연결하며 하나의 온디바이스 안전 확인 시스템을 완성했다. 공개 데이터셋과 사전 학습 모델도 실제 환경의 조명, 촬영 각도, 가림 등에 따라 성능 차이가 커서 실물 데이터 기반 검증이 중요하다는 점을 경험했고, AI 모델의 정확도뿐 아니라 추적 연속성, 이벤트 상태 관리, 네트워크 통신, UI 표현이 전체 서비스 품질을 함께 결정한다는 것을 확인했다. Jetson 환경에 C++·Python 추론, TensorRT, WebRTC, HTTPS, SQLite를 통합하며 AI 모델 개발과 시스템 엔지니어링을 함께 고려하는 경험을 얻었고, 오탐과 연결 장애를 반복적으로 개선하면서 감지 결과를 사용자가 이해하고 직접 확인할 수 있는 과정도 탐지 성능만큼 중요하다는 점을 느꼈다. 제한된 기간과 단일 카메라 환경에서도 낙상 감지와 사건 확인 흐름을 실제로 구현해, 가정용 돌봄 안전 보조 시스템의 가능성을 검증했다.

빠르게 발전하는 AI를 단순히 사용하는 데서 나아가, 데이터가 입력되고 추론 결과가 만들어지는 원리를 프로젝트를 통해 이해할 수 있었다. 객체 추적, 자세 추정, 시계열 분석, 엣지 배포처럼 처음 접한 분야도 AI를 활용해 빠르게 학습하고 실제 구현까지 연결할 수 있었으며, 원리를 이해한 이후에는 질문을 더 구체적으로 만들고 AI의 답변을 검증하며 필요한 결과를 얻는 능력도 함께 향상됐다. AI는 모르는 분야의 진입 장벽을 낮추고 학습과 구현 속도를 크게 높여 주지만, 올바르게 활용하려면 결과를 판단하고 수정할 수 있는 기초 지식이 필요하다는 점을 배웠다. 이번 프로젝트를 통해 AI 시대의 중요한 역량은 단순한 도구 사용 능력이 아니라, 문제를 정의하고 AI와 협업하며 결과를 실제 시스템으로 완성하는 능력이라고 느꼈다. AI 모델 하나의 성능을 높이는 것에서 나아가, 여러 기술을 실제 사용 가능한 서비스로 연결하는 과정을 경험한 프로젝트였다.

## 참고 문헌

[0] CDC, Older Adult Falls Data and Statistics, https://www.cdc.gov/falls/data-research/index.html

[1] 치매 노인의 낙상 위험 요인 연구, https://pmc.ncbi.nlm.nih.gov/articles/PMC5435396/

[2] WHO, Falls, https://www.who.int/news-room/fact-sheets/detail/falls

[3] Ultralytics YOLO11 Documentation

[4] OpenMMLab, MMPose / RTMPose

[5] Bewley et al., Simple Online and Realtime Tracking (SORT)

[6] URFD (UR Fall Detection Dataset)

[7] Roboflow Universe — Person Detection Datasets

[8] NVIDIA Jetson Orin Nano / JetPack / TensorRT Documentation
