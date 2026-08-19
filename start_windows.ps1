param([string]$JetsonHost = $env:WARDY_JETSON_HOST)
$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
$deviceFile = Join-Path $repo ".wardy-device"
$step = "시작 준비"

try {
  $step = "Node.js와 npm 확인"
  Get-Command node, npm | Out-Null

  if (-not $JetsonHost -and (Test-Path $deviceFile)) {
    $JetsonHost = (Get-Content $deviceFile -Raw).Trim()
  }
  if (-not $JetsonHost) {
    foreach ($candidate in @("wardy.local", "10.10.20.40")) {
      try {
        if (-not (Test-NetConnection $candidate -Port 8443 -InformationLevel Quiet)) { continue }
        $JetsonHost = $candidate
        break
      } catch {}
    }
  }
  if (-not $JetsonHost) { $JetsonHost = Read-Host "Jetson IP 또는 DNS" }
  if (-not $JetsonHost) { throw "Jetson 주소가 필요합니다." }
  Set-Content -Path $deviceFile -Value $JetsonHost -NoNewline

  Set-Location $repo
  $step = "웹 의존성 설치"
  if (-not (Test-Path (Join-Path $repo "node_modules"))) {
    Write-Host "Installing Wardy web dependencies. The initial setup can take a few minutes."
    npm ci
  }

  $caDir = Join-Path $env:LOCALAPPDATA "Wardy"
  $caFile = Join-Path $caDir "wardy-ca.crt"
  if (-not (Test-Path $caFile)) {
    $step = "Jetson CA 인증서 가져오기"
    New-Item -ItemType Directory -Force -Path $caDir | Out-Null
    $sshUser = if ($env:WARDY_SSH_USER) { $env:WARDY_SSH_USER } else { "mumallaeng" }
    scp "${sshUser}@${JetsonHost}:/etc/wardy/tls/wardy-ca.crt" $caFile
    $step = "Jetson CA 인증서 설치"
    certutil -addstore -f Root $caFile | Out-Null
  }

  $step = "Jetson 연결 점검"
  & "$repo\edge\scripts\test_windows_connection.ps1" -JetsonHost $JetsonHost -UiOrigin "http://localhost:8000"

  $url = "http://localhost:8000/?jetson=https%3A%2F%2F${JetsonHost}%3A8443"
  Start-Job -ScriptBlock { param($target) Start-Sleep 2; Start-Process $target } -ArgumentList $url | Out-Null
  Write-Host "Wardy UI 시작: $url"
  npm run serve
} catch {
  Write-Error "[실패] ${step}: $($_.Exception.Message)"
  Write-Host "다음 명령으로 확인하세요:"
  Write-Host "  node --version; npm --version"
  Write-Host "  Test-NetConnection $JetsonHost -Port 8443"
  Write-Host "  ssh ${env:USERNAME}@$JetsonHost 'systemctl status wardy-edge.service wardy-pose-fall.service'"
  Write-Host "복구 후 다시 실행: .\start_windows.ps1 -JetsonHost <Jetson IP>"
  exit 1
}
