param(
  [Parameter(Mandatory = $true)]
  [string]$JetsonHost
)

$ErrorActionPreference = "Stop"
$healthUrl = "http://${JetsonHost}:8787/api/health"
$webrtcUrl = "http://${JetsonHost}:8889/wardy"

$health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
if ($health.service -ne "wardy-edge" -or $health.camera -ne "connected") {
  throw "Jetson health response is not ready: $($health | ConvertTo-Json -Compress)"
}

$webrtcPage = Invoke-WebRequest -Uri $webrtcUrl -Method Get -TimeoutSec 5 -UseBasicParsing
if ($webrtcPage.StatusCode -ne 200) {
  throw "WebRTC handshake page returned HTTP $($webrtcPage.StatusCode)"
}

Write-Host "Jetson health API ready: ${healthUrl}"
Write-Host "WebRTC handshake ready: ${webrtcUrl}"
Write-Host "Open the Wardy browser UI and verify that the selected ICE candidate uses UDP port 8189."
