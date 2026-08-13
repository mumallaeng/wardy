# Wardy

치매 환자 안전을 위한 가정용 온디바이스 모니터링 프로젝트입니다. USB 카메라 영상은 Jetson에서 처리하며, 휴대전화 또는 PC의 웹 화면에서 영상과 안전 상태를 확인합니다.

## 실행 구조

```text
USB webcam
  → Jetson wardy-edge.service
      ├─ M-01 사람 탐지 · M-05 위험물
      ├─ M-02 추적/식별
      ├─ M-03 자세 · M-04 낙상 의심
      ├─ SQLite 이벤트/상태/검토 자료
      ├─ HTTPS API :8443
      └─ WebRTC :8189
  → Windows 또는 macOS의 http://localhost:8000
```

## 빠른 시작

저장소를 받은 뒤 현재 기기에 해당하는 스크립트 하나만 실행합니다. 최초 실행은 의존성·모델·인증서를 준비하고, 다음 실행부터 저장된 설정을 재사용합니다.

### Jetson

```bash
git clone https://github.com/mumallaeng/wardy.git ~/work/wardy
cd ~/work/wardy
./start_jetson.sh
```

Jetson IP는 기본 네트워크 경로에서 자동으로 찾습니다. 다른 주소를 사용해야 하면 최초 한 번만 전달합니다.

```bash
./start_jetson.sh 10.10.20.40
```

최초 설치 중에는 다음 안내와 경과 시간이 주기적으로 표시됩니다.

```text
Initial setup is still running. Model preparation can take several minutes. Elapsed: 120s
```

### macOS

```bash
git clone https://github.com/mumallaeng/wardy.git ~/git/wardy
cd ~/git/wardy
./start_macos.sh
```

자동 탐색이 되지 않으면 최초 한 번만 Jetson 주소를 전달합니다. 이후 `.wardy-device`에 저장되어 재사용됩니다.

```bash
./start_macos.sh 10.10.20.40
```

최초 인증서 설치 때 macOS 관리자 암호와 Jetson SSH 암호를 요청할 수 있습니다.

### Windows

PowerShell에서 실행합니다.

```powershell
git clone https://github.com/mumallaeng/wardy.git "$HOME\git\wardy"
Set-Location "$HOME\git\wardy"
.\start_windows.ps1
```

자동 탐색이 되지 않으면 최초 한 번만 주소를 전달합니다.

```powershell
.\start_windows.ps1 -JetsonHost 10.10.20.40
```

인증서를 시스템 신뢰 저장소에 설치하려면 관리자 PowerShell이 필요할 수 있습니다.

## 낙상 의심 확인

M-03 자세 시퀀스를 M-04가 시간축으로 분석해 낙상 의심 사건을 생성합니다. 사건은 모델 점수가 낮아지거나 대상이 화면에서 사라져도 자동으로 없어지지 않습니다.

- 카메라 overlay: 현재 추적·자세 상태
- '낙상 의심 확인' 카드: 처리 대기 중인 사건
- '이벤트 기록': 발생 시각과 처리 이력
- '상황 확인': 사건 확인
- '안전 확인·해제': 상황 종료
- '오탐 처리': 잘못된 감지로 종료

## 개발 검증

```bash
npm ci
npm test
npm run build

cmake -S edge -B edge/build
cmake --build edge/build -j4
ctest --test-dir edge/build --output-on-failure
```

실행 실패 시 각 시작 스크립트가 실패 단계와 다음 점검 명령을 출력합니다. 수동 점검과 복구 방법은 [문제 해결 안내](docs/troubleshooting.md)를 참고하세요.
