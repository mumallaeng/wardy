param(
  [Parameter(Mandatory = $true)]
  [string]$JetsonHost,
  [Parameter(Mandatory = $true)]
  [string]$AccessToken
)

$ErrorActionPreference = "Stop"
$healthUrl = "http://${JetsonHost}:8787/api/health"
$webrtcUrl = "http://${JetsonHost}:8889/wardy"

$health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
if ($health.service -ne "wardy-edge" -or $health.camera -ne "connected") {
  throw "Jetson health response is not ready: $($health | ConvertTo-Json -Compress)"
}

$credentialBytes = [Text.Encoding]::ASCII.GetBytes("wardy-viewer:${AccessToken}")
$authorization = "Basic $([Convert]::ToBase64String($credentialBytes))"
$webrtcPage = Invoke-WebRequest -Uri $webrtcUrl -Method Get -Headers @{ Authorization = $authorization } -TimeoutSec 5 -UseBasicParsing
if ($webrtcPage.StatusCode -ne 200) {
  throw "WebRTC handshake page returned HTTP $($webrtcPage.StatusCode)"
}

Write-Host "Jetson health API ready: ${healthUrl}"
Write-Host "WebRTC handshake ready: ${webrtcUrl}"
Write-Host "Open the Wardy browser UI and verify that the selected ICE candidate uses UDP port 8189."
