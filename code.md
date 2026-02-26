param(
[int]$Port = 18789,
  [switch]$ReuseGateway = $false
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-PortOpen {
param([int]$TestPort)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $TestPort, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(600)
    if (-not $ok) {
      $client.Close()
      return $false
    }
    $client.EndConnect($iar)
$client.Close()
return $true
} catch {
return $false
}
}

function Get-PortOwnerPids {
param([int]$TestPort)
  try {
    $rows = Get-NetTCPConnection -State Listen -LocalAddress "127.0.0.1" -LocalPort $TestPort -ErrorAction SilentlyContinue
    if ($rows) {
return @($rows | Select-Object -ExpandProperty OwningProcess -Unique)
    }
  } catch {
    # ignore and fall through
  }
  $match = netstat -ano | Select-String "127\.0\.0\.1:$TestPort\s+.\*LISTENING"
if (-not $match) {
    return @()
  }
  $pids = @()
  foreach ($line in $match) {
    $parts = ($line.ToString() -split "\s+") | Where-Object { $_ -and $_.Trim().Length -gt 0 }
    if ($parts.Length -ge 5) {
$ownerProcessId = 0
      if ([int]::TryParse($parts[-1], [ref]$ownerProcessId) -and $ownerProcessId -gt 0) {
        $pids += $ownerProcessId
      }
    }
  }
  return @($pids | Select-Object -Unique)
}

Write-Host "Building UI..." -ForegroundColor Cyan
pnpm --dir ui build
if ($LASTEXITCODE -ne 0) {
throw "UI build failed."
}

$gatewayLog = Join-Path $env:TEMP "moltbot-gateway.log"
$gatewayErrLog = Join-Path $env:TEMP "moltbot-gateway.err.log"
$gatewayProc = $null
$reusedGateway = $false

if ((Test-PortOpen -TestPort $Port) -and -not $ReuseGateway) {
  $pids = Get-PortOwnerPids -TestPort $Port
  if ($pids.Count -gt 0) {
Write-Host "Stopping existing gateway listener(s) on :$Port ($($pids -join ', ')) ..." -ForegroundColor Yellow
    foreach ($ownerPid in $pids) {
try {
Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
} catch { # ignore kill failures; startup probe will validate.
}
}
Start-Sleep -Milliseconds 400
}
}

if ((Test-PortOpen -TestPort $Port) -and $ReuseGateway) {
  $reusedGateway = $true
  Write-Host "Reusing existing gateway on loopback:$Port ..." -ForegroundColor Green
} else {
Write-Host "Starting gateway on loopback:$Port ..." -ForegroundColor Cyan
  $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeCmd) {
    throw "node not found in PATH."
  }
  $gatewayProc = Start-Process `
    -FilePath $nodeCmd `
    -ArgumentList @("scripts/run-node.mjs", "gateway", "run", "--bind", "loopback", "--port", "$Port", "--force", "--allow-unconfigured") `    -WorkingDirectory $root`
-WindowStyle Hidden `    -RedirectStandardOutput $gatewayLog`
-RedirectStandardError $gatewayErrLog `
-PassThru
}

for ($i = 0; $i -lt 40; $i++) {
if (Test-PortOpen -TestPort $Port) {
break
}
Start-Sleep -Milliseconds 500
}

if (-not (Test-PortOpen -TestPort $Port)) {
  Write-Host "Gateway did not start. Last log lines:" -ForegroundColor Red
  if (Test-Path $gatewayLog) {
    Get-Content $gatewayLog -Tail 60 | Out-Host
  }
  if (Test-Path $gatewayErrLog) {
    Get-Content $gatewayErrLog -Tail 60 | Out-Host
  }
  throw "Gateway failed to bind 127.0.0.1:$Port."
}

$appUrl = "http://127.0.0.1:$Port/chat"

$edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$chromePath = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"

if (Test-Path $edgePath) {
  Write-Host "Opening desktop window with Edge app mode..." -ForegroundColor Green
  Start-Process -FilePath $edgePath -ArgumentList @("--app=$appUrl", "--new-window")
} elseif (Test-Path $chromePath) {
  Write-Host "Opening desktop window with Chrome app mode..." -ForegroundColor Green
  Start-Process -FilePath $chromePath -ArgumentList @("--app=$appUrl", "--new-window")
} else {
Write-Host "No Edge/Chrome found. Open this URL manually: $appUrl" -ForegroundColor Yellow
}

if ($reusedGateway) {
  Write-Host "Gateway already running. To stop it: pnpm openclaw gateway stop" -ForegroundColor DarkGray
} else {
  Write-Host "Gateway PID: $($gatewayProc.Id)" -ForegroundColor DarkGray
Write-Host "To stop gateway: Stop-Process -Id $($gatewayProc.Id)" -ForegroundColor DarkGray
}
Write-Host "Gateway log: $gatewayLog" -ForegroundColor DarkGray
Write-Host "Gateway err log: $gatewayErrLog" -ForegroundColor DarkGray

param(
[int]$Port = 18789,
  [switch]$ReuseGateway = $false
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-PortOpen {
param([int]$TestPort)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $TestPort, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(600)
    if (-not $ok) {
      $client.Close()
      return $false
    }
    $client.EndConnect($iar)
$client.Close()
return $true
} catch {
return $false
}
}

function Get-PortOwnerPids {
param([int]$TestPort)
  try {
    $rows = Get-NetTCPConnection -State Listen -LocalAddress "127.0.0.1" -LocalPort $TestPort -ErrorAction SilentlyContinue
    if ($rows) {
return @($rows | Select-Object -ExpandProperty OwningProcess -Unique)
    }
  } catch {
    # ignore and fall through
  }
  $match = netstat -ano | Select-String "127\.0\.0\.1:$TestPort\s+.\*LISTENING"
if (-not $match) {
    return @()
  }
  $pids = @()
  foreach ($line in $match) {
    $parts = ($line.ToString() -split "\s+") | Where-Object { $_ -and $_.Trim().Length -gt 0 }
    if ($parts.Length -ge 5) {
$pid = 0
      if ([int]::TryParse($parts[-1], [ref]$pid) -and $pid -gt 0) {
        $pids += $pid
      }
    }
  }
  return @($pids | Select-Object -Unique)
}

Write-Host "Building UI..." -ForegroundColor Cyan
pnpm --dir ui build
if ($LASTEXITCODE -ne 0) {
throw "UI build failed."
}

$gatewayLog = Join-Path $env:TEMP "moltbot-gateway.log"
$gatewayErrLog = Join-Path $env:TEMP "moltbot-gateway.err.log"
$gatewayProc = $null
$reusedGateway = $false

if ((Test-PortOpen -TestPort $Port) -and -not $ReuseGateway) {
  $pids = Get-PortOwnerPids -TestPort $Port
  if ($pids.Count -gt 0) {
Write-Host "Stopping existing gateway listener(s) on :$Port ($($pids -join ', ')) ..." -ForegroundColor Yellow
    foreach ($ownerPid in $pids) {
try {
Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
} catch { # ignore kill failures; startup probe will validate.
}
}
Start-Sleep -Milliseconds 400
}
}

if ((Test-PortOpen -TestPort $Port) -and $ReuseGateway) {
  $reusedGateway = $true
  Write-Host "Reusing existing gateway on loopback:$Port ..." -ForegroundColor Green
} else {
Write-Host "Starting gateway on loopback:$Port ..." -ForegroundColor Cyan
  $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeCmd) {
    throw "node not found in PATH."
  }
  $gatewayProc = Start-Process `
    -FilePath $nodeCmd `
    -ArgumentList @("scripts/run-node.mjs", "gateway", "run", "--bind", "loopback", "--port", "$Port", "--force", "--allow-unconfigured") `    -WorkingDirectory $root`
-WindowStyle Hidden `    -RedirectStandardOutput $gatewayLog`
-RedirectStandardError $gatewayErrLog `
-PassThru
}

for ($i = 0; $i -lt 40; $i++) {
if (Test-PortOpen -TestPort $Port) {
break
}
Start-Sleep -Milliseconds 500
}

if (-not (Test-PortOpen -TestPort $Port)) {
  Write-Host "Gateway did not start. Last log lines:" -ForegroundColor Red
  if (Test-Path $gatewayLog) {
    Get-Content $gatewayLog -Tail 60 | Out-Host
  }
  if (Test-Path $gatewayErrLog) {
    Get-Content $gatewayErrLog -Tail 60 | Out-Host
  }
  throw "Gateway failed to bind 127.0.0.1:$Port."
}

$appUrl = "http://127.0.0.1:$Port/chat"

$edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$chromePath = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"

if (Test-Path $edgePath) {
  Write-Host "Opening desktop window with Edge app mode..." -ForegroundColor Green
  Start-Process -FilePath $edgePath -ArgumentList @("--app=$appUrl", "--new-window")
} elseif (Test-Path $chromePath) {
  Write-Host "Opening desktop window with Chrome app mode..." -ForegroundColor Green
  Start-Process -FilePath $chromePath -ArgumentList @("--app=$appUrl", "--new-window")
} else {
Write-Host "No Edge/Chrome found. Open this URL manually: $appUrl" -ForegroundColor Yellow
}

if ($reusedGateway) {
  Write-Host "Gateway already running. To stop it: pnpm openclaw gateway stop" -ForegroundColor DarkGray
} else {
  Write-Host "Gateway PID: $($gatewayProc.Id)" -ForegroundColor DarkGray
Write-Host "To stop gateway: Stop-Process -Id $($gatewayProc.Id)" -ForegroundColor DarkGray
}
Write-Host "Gateway log: $gatewayLog" -ForegroundColor DarkGray
Write-Host "Gateway err log: $gatewayErrLog" -ForegroundColor DarkGray
