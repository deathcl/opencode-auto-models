# Instala el plugin auto-models en este usuario.
# Uso:  powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

$destDir = Join-Path $env:USERPROFILE ".config\opencode\plugins"
$dest = Join-Path $destDir "auto-models.ts"
$src = Join-Path $PSScriptRoot "auto-models.ts"

if (-not (Test-Path $src)) {
  Write-Error "No encuentro auto-models.ts junto a install.ps1"
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item $src $dest -Force

Write-Host "Instalado en: $dest"
Write-Host "Reinicia OpenCode. Con tus gateways arriba, corre /sync-models o espera el sondeo de 5 minutos."
