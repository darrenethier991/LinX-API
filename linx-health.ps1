# linx-health.ps1 — Checks that all LinX workers are responding.
# Run from anywhere:  .\linx-health.ps1
# Exits 0 if all workers respond, 1 if any are unreachable.

$checks = @(
    @{ Label = "linx-api";        Url = "https://api.linxservices.ca/health" },
    @{ Label = "linx-ai-gateway"; Url = "https://ai.linxservices.ca/health" },
    @{ Label = "linx-sms";        Url = "https://sms.linxservices.ca/" }
)

Write-Host "`n=== LinX Health Check ===" -ForegroundColor Cyan
$failed = 0

foreach ($c in $checks) {
    try {
        $resp = Invoke-WebRequest -Uri $c.Url -TimeoutSec 15 -UseBasicParsing
        $code = [int]$resp.StatusCode
        $detail = ""
        if ($c.Url -like "*/health" -and $resp.Content) {
            try {
                $json = $resp.Content | ConvertFrom-Json
                if ($json.version) { $detail = " (version $($json.version))" }
            } catch { }
        }
        Write-Host "  [UP]   $($c.Label) -> HTTP $code$detail" -ForegroundColor Green
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -and $code -ge 400 -and $code -lt 500) {
            # Worker answered (4xx = alive, just refused/unknown path)
            Write-Host "  [UP]   $($c.Label) -> HTTP $code (responding)" -ForegroundColor Green
        } else {
            $msg = if ($code) { "HTTP $code" } else { $_.Exception.Message }
            Write-Host "  [DOWN] $($c.Label) -> $msg" -ForegroundColor Red
            $failed++
        }
    }
}

if ($failed -eq 0) {
    Write-Host "`nAll workers responding." -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n$failed worker(s) unreachable." -ForegroundColor Red
    exit 1
}
