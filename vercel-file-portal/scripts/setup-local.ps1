# Install and run from a local folder (Google Drive breaks npm install).
$Source = Split-Path $PSScriptRoot -Parent
$Target = Join-Path $env:LOCALAPPDATA "vercel-file-portal-dev"

Write-Host "Copying project to $Target ..."
robocopy $Source $Target /E /XD node_modules .next .upload-storage /NFL /NDL /NJH /NJS | Out-Null

Set-Location $Target
Write-Host "Installing dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Ready. Start the dev server with:"
Write-Host "  cd `"$Target`""
Write-Host "  npm run dev"
