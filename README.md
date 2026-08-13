# Wardy

병실·요양시설용 온디바이스 안전 모니터링 프로젝트입니다. USB 카메라 영상과 AI 추론은 Jetson에서 처리하며, Windows 또는 macOS 브라우저는 Jetson의 HTTPS API와 WebRTC 영상에 연결합니다.

> Wardy의 낙상·위험 감지는 안전 확인을 돕는 보조 정보입니다. 의료 진단이나 자동 구조 판단을 대신하지 않습니다.

## 실행 구조

```text
USB webcam
  → Jetson wardy-edge.service
      ├─ M-01 사람 탐지 · M-02 추적/식별
      ├─ M-03 자세 · M-04 낙상 의심 · M-05 위험물
      ├─ SQLite 이벤트/상태/검토 자료
      ├─ HTTPS API :8443
      └─ WebRTC :8189
  → Windows 또는 macOS의 http://localhost:8000
```

브라우저 UI와 Jetson 런타임은 서로 다른 프로세스입니다.

- Jetson: 카메라, AI, 이벤트, 로컬 데이터, HTTPS/WebRTC 서비스
- Windows/macOS: UI 개발 서버와 브라우저
- 기본 UI Origin: `http://localhost:8000`
- 기본 Jetson URL 예시: `https://10.10.20.40:8443`

아래 명령의 `10.10.20.40`은 실제 Jetson IP 또는 DNS 이름으로 바꾸세요. 최초 설치에 사용한 주소는 TLS 인증서에도 포함되므로 같은 주소를 계속 사용하는 것이 안전합니다.

## 1. Jetson 처음 설치

### 준비 사항

- Ubuntu 22.04 기반 Jetson/JetPack 6
- `/dev/video0`으로 인식되는 USB 카메라
- GitHub 저장소 접근 권한
- 인터넷 연결
- 최소 수 GB의 모델·빌드 여유 공간

```bash
git clone https://github.com/mumallaeng/wardy.git ~/work/wardy
cd ~/work/wardy
git switch main

./edge/scripts/setup_jetson.sh \
  10.10.20.40 \
  http://localhost:8000
```

이 스크립트는 필요한 패키지, Python 가상환경, 모델, TensorRT 엔진, Ollama, TLS 인증서와 systemd 서비스를 준비합니다. 첫 TensorRT 엔진 생성은 Jetson에서 수 분 이상 걸릴 수 있습니다.

설치 후 상태를 확인합니다.

```bash
systemctl --no-pager --full status \
  wardy-pose-fall.service \
  wardy-edge.service

curl --cacert /etc/wardy/tls/wardy-ca.crt \
  https://10.10.20.40:8443/api/health
```

정상 health 응답 예시:

```json
{"service":"wardy-edge","version":"0.1.0","camera":"connected"}
```

### Jetson 코드 업데이트 후 재배포

최초 설치가 끝난 장비에서는 보통 전체 `setup_jetson.sh`를 다시 실행할 필요가 없습니다.

```bash
cd ~/work/wardy

git fetch origin
git switch main
git pull --ff-only origin main

cmake -S edge -B edge/build
cmake --build edge/build -j"$(nproc)"
ctest --test-dir edge/build --output-on-failure

sudo systemctl restart wardy-pose-fall.service wardy-edge.service
systemctl is-active wardy-pose-fall.service wardy-edge.service
```

의존성, 모델 레지스트리, TLS 설정 또는 systemd unit이 변경된 릴리스라면 setup을 다시 실행합니다.

```bash
cd ~/work/wardy
./edge/scripts/setup_jetson.sh 10.10.20.40 http://localhost:8000
```

### Jetson 로그 확인

실시간 로그:

```bash
sudo journalctl \
  -u wardy-pose-fall.service \
  -u wardy-edge.service \
  -f
```

최근 10분 로그:

```bash
journalctl \
  -u wardy-pose-fall.service \
  -u wardy-edge.service \
  --since "10 minutes ago" \
  --no-pager
```

API 자체 점검:

```bash
cd ~/work/wardy
./edge/scripts/test_jetson_runtime.sh
```

카메라가 보이지 않을 때:

```bash
ls -l /dev/video0
v4l2-ctl --list-devices
sudo systemctl restart wardy-edge.service
```

`Cannot identify device '/dev/video0'`은 카메라 장치가 일시적으로 사라졌다는 뜻입니다. USB 연결과 전원을 확인한 뒤 서비스를 재시작하세요.

## 2. Windows에서 실행

### 저장소와 UI 준비

PowerShell에서 실행합니다.

```powershell
git clone https://github.com/mumallaeng/wardy.git "$HOME\git\wardy"
Set-Location "$HOME\git\wardy"
npm ci
npm run serve
```

브라우저에서 `http://localhost:8000`을 열고 'Jetson 연결'에 다음 주소를 저장합니다.

```text
https://10.10.20.40:8443
```

### Jetson CA 인증서 신뢰

Jetson에서 Windows로 공개 CA 인증서만 복사합니다. 개인 키 파일은 복사하지 마세요.

```powershell
scp mumallaeng@10.10.20.40:/etc/wardy/tls/wardy-ca.crt "$HOME\Downloads\wardy-ca.crt"
```

관리자 PowerShell에서 로컬 컴퓨터의 신뢰 루트에 설치합니다.

```powershell
certutil -addstore -f Root "$HOME\Downloads\wardy-ca.crt"
```

브라우저를 완전히 종료했다가 다시 열고 다음 주소가 경고 없이 열리는지 확인합니다.

```text
https://10.10.20.40:8443/api/health
```

### Windows 연결 자동 점검

UI 서버를 실행한 상태에서 별도 PowerShell을 엽니다.

```powershell
Set-Location "$HOME\git\wardy"
PowerShell -ExecutionPolicy Bypass -File .\edge\scripts\test_windows_connection.ps1 `
  -JetsonHost 10.10.20.40 `
  -UiOrigin http://localhost:8000
```

점검 스크립트는 health, 운영 API와 WebRTC WHEP signaling을 검사합니다. 실제 영상은 브라우저에서 확인합니다.

Windows 방화벽 또는 사설망 정책에서는 다음 연결을 허용해야 합니다.

- TCP `8443`: Jetson HTTPS API와 signaling
- TCP/UDP `8189`: WebRTC media
- TCP `22`: SSH와 유지보수에 사용하는 경우

## 3. macOS에서 실행

### 저장소와 UI 준비

```bash
git clone https://github.com/mumallaeng/wardy.git ~/git/wardy
cd ~/git/wardy
npm ci
npm run serve
```

브라우저에서 `http://localhost:8000`을 열고 'Jetson 연결'에 다음 주소를 저장합니다.

```text
https://10.10.20.40:8443
```

### Jetson CA 인증서 신뢰

```bash
scp mumallaeng@10.10.20.40:/etc/wardy/tls/wardy-ca.crt \
  ~/Downloads/wardy-ca.crt

sudo security add-trusted-cert \
  -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/Downloads/wardy-ca.crt
```

Chrome을 완전히 종료했다가 다시 열고 health를 확인합니다.

```bash
curl --cacert ~/Downloads/wardy-ca.crt \
  https://10.10.20.40:8443/api/health
```

### SSH 별칭을 사용하는 경우

이미 `~/.ssh/config`에 Jetson 별칭과 필요한 포트 전달이 구성되어 있다면 터널을 먼저 유지합니다.

```bash
ssh -N wardy-jetson-macos
```

다른 터미널에서 UI를 실행합니다.

```bash
cd ~/git/wardy
npm run serve
```

`Address already in use`가 표시되면 같은 SSH 터널이 이미 실행 중인지 확인합니다.

```bash
pgrep -af 'ssh.*wardy-jetson-macos'
```

Jetson이 같은 LAN 또는 WireGuard 주소로 직접 연결된다면 SSH 터널은 필요하지 않습니다.

## 4. UI 사용과 낙상 확인

1. `http://localhost:8000`을 엽니다.
2. 'Jetson 연결'에서 `https://10.10.20.40:8443`을 저장합니다.
3. 'Jetson 카메라 연결'을 누릅니다.
4. 시스템 상태의 카메라·안전 감지·이벤트 처리 항목이 정상인지 확인합니다.

낙상은 단일 프레임의 누운 자세만으로 판단하지 않습니다. M-03 자세 시퀀스를 M-04가 시간축으로 분석해 낙상 의심 점수가 임계값을 넘으면 사건을 생성합니다.

- 카메라 overlay: 현재 프레임의 추적·자세 표시
- '낙상 의심 확인' 카드: 처리할 때까지 유지되는 낙상 사건
- '이벤트 기록': 발생 시각, 대상, 상태, 자료와 처리 이력

낙상 의심 사건은 모델 점수가 다시 낮아지거나 대상이 화면에서 사라져도 자동 해제되지 않습니다.

- '상황 확인': 사건을 확인 상태로 변경
- '안전 확인·해제': 상황 종료
- '오탐 처리': 잘못된 감지로 종료

## 5. 개발과 검증

웹 UI 전체 검사:

```bash
npm ci
npm test
npm run build
```

Edge C++ 검사:

```bash
cmake -S edge -B edge/build
cmake --build edge/build -j4
ctest --test-dir edge/build --output-on-failure
```

Jetson 의존성 검사:

```bash
./edge/scripts/check_jetson_dependencies.sh
```

## 6. 빠른 문제 해결

| 증상 | 확인할 내용 |
|---|---|
| UI에 '확인 불가' 표시 | `journalctl`에서 카메라 또는 추론 worker 오류 확인, 두 서비스 재시작 |
| `502` 또는 `127.0.0.1:8787 i/o timeout` | 브라우저 요청 과부하 또는 edge 응답 지연 확인, 최신 코드 적용 후 서비스 재시작 |
| WebRTC `no stream is available` | `/dev/video0`, `wardy-edge.service`, MediaMTX publish 로그 확인 |
| `Cannot identify device '/dev/video0'` | USB 카메라 연결·전원·장치 번호 확인 |
| 인증서 경고 | 접속 주소가 인증서의 Jetson IP/DNS와 같은지 확인하고 `wardy-ca.crt` 재설치 |
| 화면 상태가 갱신되지 않음 | Jetson health, `/api/ws`, UI Origin이 `http://localhost:8000`인지 확인 |
| 낙상 카드가 사라지지 않음 | 의도된 사건 유지 동작이며, 확인 후 '안전 확인·해제' 또는 '오탐 처리' 선택 |

서비스를 한 번에 재시작하는 명령:

```bash
sudo systemctl restart wardy-pose-fall.service wardy-edge.service
```
