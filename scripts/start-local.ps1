$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Force -Path '.local' | Out-Null
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:4318/health' -TimeoutSec 2
    if ($health.service -eq 'vibe-iter-whisper') {
        Write-Host "Vibe Iter local transcription is running. Ready: $($health.ready)"
        exit 0
    }
} catch { }
$python = (Get-Command python).Source
$process = Start-Process -FilePath $python -ArgumentList @('scripts/transcription_server.py') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput "$projectRoot/.local/whisper.log" -RedirectStandardError "$projectRoot/.local/whisper-error.log" -PassThru
$process.Id | Set-Content '.local/whisper.pid'
Write-Host "Started Vibe Iter local transcription (PID $($process.Id))."
Write-Host 'Status: http://127.0.0.1:4318/health'
Write-Host 'Session audio stays on this computer, in .local/sessions. Diagnostic WAV clips: .local/voice-clips.'
