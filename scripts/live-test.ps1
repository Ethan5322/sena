# ============================================================================
# Sena — the live call, one command:   npm run call
#
# Exists because the manual version is five steps across two terminals and a
# browser, and every step has a way to look "failed" when it is merely not
# started. This script checks each precondition IN ORDER, says plainly what is
# missing, starts what it can itself, and opens the browser only when there is
# actually something to open.
#
# Windows PowerShell 5.1 — no &&, no ternary.
# ============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg)  { Write-Host "  $msg" }
function Good($msg) { Write-Host "  OK    $msg" -ForegroundColor Green }
function Bad($msg)  { Write-Host "  STOP  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "Sena — live call preflight" -ForegroundColor Cyan
Write-Host ""

# ── 1. The brain ────────────────────────────────────────────────────────────
# Two ways to have one: LLM_PROVIDER=ollama (free, local, slow on this laptop)
# or LLM_PROVIDER=anthropic plus a key. Whichever .env.local says, verify it.
if (-not (Test-Path .env.local)) {
    Bad ".env.local does not exist. Copy .env.example and fill it in."
    exit 1
}
$envText = Get-Content .env.local -Raw
$usingOllama = $envText -match '(?m)^\s*LLM_PROVIDER\s*=\s*ollama'

if ($usingOllama) {
    $ollamaUp = $false
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ollamaUp = $true }
    } catch { }
    if (-not $ollamaUp) {
        # Installed but not running is the common case — it starts on login
        # normally, but not on the login where it was first installed.
        $exe = "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
        if (Test-Path $exe) {
            Say "Ollama is installed but not running - starting it..."
            Start-Process $exe
            Start-Sleep -Seconds 8
            try {
                $r = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 3
                if ($r.StatusCode -eq 200) { $ollamaUp = $true }
            } catch { }
        }
    }
    if (-not $ollamaUp) {
        Bad "LLM_PROVIDER is ollama but Ollama is not running and could not be started."
        Say "Install it (winget install Ollama.Ollama), then run 'npm run call' again."
        exit 1
    }
    Good "brain: Ollama, free and local (expect slow replies on this machine)"
} elseif ($envText -match 'PASTE-YOUR-KEY-HERE' -or $envText -match '(?m)^\s*ANTHROPIC_API_KEY\s*=\s*$') {
    Bad "LLM_PROVIDER is anthropic but no API key is in .env.local."
    Say "Either paste your key from console.anthropic.com -> API keys,"
    Say "or set LLM_PROVIDER=ollama to test free without one."
    exit 1
} else {
    Good "brain: Claude (API key is filled in)"
}

# ── 2. Has the machine been rebooted since WSL was installed? ───────────────
wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
    Bad "WSL is not working yet - the machine has not been rebooted since it was installed."
    Say "Reboot Windows, then run 'npm run call' again. Docker cannot start before the reboot."
    exit 1
}
Good "WSL is working (the reboot happened)"

# ── 3. Docker engine ────────────────────────────────────────────────────────
$dockerExe = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
if (-not (Test-Path $dockerExe)) { $dockerExe = "docker" }

& $dockerExe info *> $null
if ($LASTEXITCODE -ne 0) {
    Say "Docker engine is not running - starting Docker Desktop..."
    $desktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (-not (Test-Path $desktop)) {
        Bad "Docker Desktop is not installed at the expected path."
        exit 1
    }
    Start-Process $desktop
    Say "waiting for the engine (first start takes a few minutes)..."
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        & $dockerExe info *> $null
        if ($LASTEXITCODE -eq 0) { break }
    }
    & $dockerExe info *> $null
    if ($LASTEXITCODE -ne 0) {
        Bad "Docker engine did not come up in 5 minutes."
        Say "If Docker Desktop is showing a service agreement or setup screen,"
        Say "click through it, wait for the whale icon to go steady, then rerun."
        exit 1
    }
}
Good "Docker engine is running"

# ── 4. The brain (npm run dev) ──────────────────────────────────────────────
$brainUp = $false
try {
    Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 2 *> $null
    $brainUp = $true
} catch {
    # a 404 from our own dev server still proves it is up
    if ($_.Exception.Response) { $brainUp = $true }
}
if (-not $brainUp) {
    Say "starting the brain (npm run dev) in its own window..."
    Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$root'; npm run dev"
    Start-Sleep -Seconds 6
}
Good "the brain is on http://localhost:3000 (demo mode: fake money, mail lands in .sena-demo-mail\)"

# ── 5. The voice (docker compose) ───────────────────────────────────────────
$voiceUp = $false
try {
    $h = Invoke-WebRequest -Uri "http://localhost:8080/health" -UseBasicParsing -TimeoutSec 2
    if ($h.StatusCode -eq 200) { $voiceUp = $true }
} catch { }

if (-not $voiceUp) {
    Say "starting the voice stack in its own window..."
    Say "FIRST BUILD DOWNLOADS ~2GB (Whisper weights, Torch) - 10 to 15 minutes."
    Say "Later starts take seconds. Watch progress in the new window."
    Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$root'; docker compose --env-file .env.local up --build"

    Say "waiting for the switchboard on http://localhost:8080 ..."
    $deadline = (Get-Date).AddMinutes(25)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 10
        try {
            $h = Invoke-WebRequest -Uri "http://localhost:8080/health" -UseBasicParsing -TimeoutSec 2
            if ($h.StatusCode -eq 200) { $voiceUp = $true; break }
        } catch { }
    }
    if (-not $voiceUp) {
        Bad "the voice stack did not come up. Look at the compose window for the error,"
        Say "and paste its last lines to Claude."
        exit 1
    }
}
Good "the voice is on http://localhost:8080"

# ── 6. The call ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Everything is up. Opening the reception page..." -ForegroundColor Cyan
Write-Host ""
Say "click  CALL RECEPTION  and allow the microphone."
Say "Sena answers within a few seconds, tells you she is an AI, and asks your name."
Say ""
Say "To book: give dates + your details (she confirms them twice - that is the"
Say "gate, not a glitch). Her 'payment link email' lands in .sena-demo-mail\ -"
Say "open the newest .html, click the link, tell her you have paid."
Write-Host ""
Start-Process "http://localhost:8080"
