param(
  [Parameter(Mandatory = $true)]
  [string]$JetsonHost,
  [Parameter(Mandatory = $true)]
  [string]$UiOrigin,
  [Parameter(Mandatory = $true)]
  [SecureString]$ViewerToken
)

$ErrorActionPreference = "Stop"
$baseUrl = "https://${JetsonHost}:8443"
$healthUrl = "${baseUrl}/api/health"
$whepUrl = "${baseUrl}/wardy/whep"

try {
  $health = Invoke-RestMethod -Uri $healthUrl -Method Get -Headers @{ Origin = $UiOrigin } -TimeoutSec 5
} catch {
  throw "Jetson HTTPS health check failed: $($_.Exception.Message)"
}
if ($health.service -ne "wardy-edge" -or $health.camera -ne "connected") {
  throw "Jetson health response is not ready: $($health | ConvertTo-Json -Compress)"
}

$plainToken = [Net.NetworkCredential]::new("", $ViewerToken).Password
try {
  $credentialBytes = [Text.Encoding]::UTF8.GetBytes("wardy-viewer:${plainToken}")
  $authorization = "Basic $([Convert]::ToBase64String($credentialBytes))"
} finally {
  $plainToken = $null
}

$offer = @"
v=0
o=- 0 0 IN IP4 0.0.0.0
s=-
t=0 0
a=group:BUNDLE 0
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=mid:0
a=recvonly
a=rtcp-mux
a=ice-ufrag:wardytest
a=ice-pwd:wardytestpassword123456
a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
a=setup:actpass
a=rtpmap:96 H264/90000
"@ -replace "`n", "`r`n"

$headers = @{ Authorization = $authorization; Origin = $UiOrigin }
try {
  $whep = Invoke-WebRequest -Uri $whepUrl -Method Post -Headers $headers `
    -ContentType "application/sdp" -Body $offer -TimeoutSec 5 -UseBasicParsing
} catch {
  throw "WebRTC WHEP handshake failed for origin ${UiOrigin}: $($_.Exception.Message)"
}
if ($whep.StatusCode -ne 201) {
  throw "WebRTC WHEP handshake returned HTTP $($whep.StatusCode)"
}

$resourceLocation = $whep.Headers.Location
if ($resourceLocation) {
  $locationUri = [Uri]::new([Uri]$whepUrl, $resourceLocation)
  $resourceUrl = "${baseUrl}$($locationUri.PathAndQuery)"
  $deleteHeaders = $headers.Clone()
  $deleteHeaders["If-Match"] = "*"
  try {
    Invoke-WebRequest -Uri $resourceUrl -Method Delete -Headers $deleteHeaders `
      -TimeoutSec 5 -UseBasicParsing | Out-Null
  } catch {
    Write-Warning "WHEP test session cleanup failed: $($_.Exception.Message)"
  }
}

Write-Host "Jetson HTTPS health API ready: ${healthUrl}"
Write-Host "WebRTC WHEP signaling ready: ${whepUrl}"
Write-Host "Open the Wardy browser UI and verify UDP media on port 8189."
