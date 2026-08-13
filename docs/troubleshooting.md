# Wardy 문제 해결

## Jetson 서비스

```bash
systemctl --no-pager --full status \
  wardy-pose-fall.service wardy-edge.service

journalctl \
  -u wardy-pose-fall.service \
  -u wardy-edge.service \
  --since "10 minutes ago" \
  --no-pager

sudo systemctl restart wardy-pose-fall.service wardy-edge.service
```

실시간 로그:

```bash
journalctl -u wardy-pose-fall.service -u wardy-edge.service -f
```

## 카메라

```bash
ls -l /dev/video0
v4l2-ctl --list-devices
sudo systemctl restart wardy-edge.service
```

`Cannot identify device '/dev/video0'`은 USB 카메라가 일시적으로 사라졌거나 장치 번호가 바뀌었다는 뜻입니다.

## Jetson API

```bash
curl --cacert /etc/wardy/tls/wardy-ca.crt \
  https://JETSON_IP:8443/api/health

./edge/scripts/test_jetson_runtime.sh
./edge/scripts/check_jetson_dependencies.sh
```

정상 health 응답:

```json
{"service":"wardy-edge","version":"0.1.0","camera":"connected"}
```

## 자주 보이는 증상

| 증상 | 다음 작업 |
|---|---|
| UI에 '확인 불가' 표시 | 두 Jetson 서비스의 최근 로그를 확인하고 재시작 |
| `502` 또는 `127.0.0.1:8787 i/o timeout` | 최신 코드를 받은 뒤 edge 서비스를 빌드·재시작 |
| WebRTC `no stream is available` | `/dev/video0`과 `wardy-edge.service` 확인 |
| 인증서 경고 | 접속 주소와 인증서의 Jetson IP/DNS가 같은지 확인 |
| 화면 상태가 갱신되지 않음 | `:8443/api/health`, `/api/ws`, UI Origin 확인 |
| 낙상 카드가 사라지지 않음 | 정상적인 사건 유지 동작이며 '안전 확인·해제' 또는 '오탐 처리' 선택 |

## 수동 Jetson 재설치

시작 스크립트의 자동 복구로 해결되지 않을 때 실행합니다.

```bash
cd ~/work/wardy
./edge/scripts/setup_jetson.sh JETSON_IP http://localhost:8000
```

코드만 다시 빌드할 때:

```bash
cd ~/work/wardy
git fetch origin
git switch main
git pull --ff-only origin main
cmake -S edge -B edge/build
cmake --build edge/build -j"$(nproc)"
ctest --test-dir edge/build --output-on-failure
sudo systemctl restart wardy-pose-fall.service wardy-edge.service
```

## macOS SSH 터널

직접 LAN 또는 WireGuard 연결을 사용할 수 없고 `~/.ssh/config`에 별칭이 구성된 경우:

```bash
ssh -N wardy-jetson-macos
```

중복 터널 확인:

```bash
pgrep -af 'ssh.*wardy-jetson-macos'
```

`Address already in use`는 같은 포트 전달이 이미 실행 중일 가능성이 큽니다.

## 네트워크 포트

- TCP `8443`: HTTPS API와 WebRTC signaling
- TCP/UDP `8189`: WebRTC media
- TCP `22`: SSH 유지보수와 최초 CA 인증서 복사
