# deploy-linx.ps1 — Deploys all LinX workers from this repo.
# Run from anywhere:  .\deploy-linx.ps1
# Deploys: linx-api (default env), linx-sms (--env sms), linx-ai-gateway (--env ai)

$ErrorActionPreference = "Stop"
Set-Location "C:\Users\darre\OneDrive\linx-api"

Write-Host "`n=== LinX Deploy ===" -ForegroundColor Cyan

Write-Host "`n[1/4] Pulling latest from GitHub..." -ForegroundColor Yellow
git pull --rebase origin main
if ($LASTEXITCODE -ne 0) { Write-Error "git pull failed"; exit 1 }

$targets = @(
    @{ Env = $null;  Label = "linx-api (api.linxservices.ca)" },
    @{ Env = "sms";  Label = "linx-sms (sms.linxservices.ca)" },
    @{ Env = "ai";   Label = "linx-ai-gateway (ai.linxservices.ca)" }
)

$i = 2
foreach ($t in $targets) {
    Write-Host "`n[$i/4] Deploying $($t.Label)..." -ForegroundColor Yellow
    if ($null -eq $t.Env) { wrangler deploy } else { wrangler deploy --env $t.Env }
    if ($LASTEXITCODE -ne 0) { Write-Error "Deploy FAILED for $($t.Label)"; exit 1 }
    $i++
}

Write-Host "`n=== All 3 workers deployed ===" -ForegroundColor Green
Write-Host "Run .\linx-health.ps1 to verify they are responding."
