# === REAL ENDPOINTS  ===
$HUB    = "https://lublin-events-hub.elenipster.workers.dev/"
$ZOOM   = "https://zoom-lublin-2hub.elenipster.workers.dev/"
$OFFICIAL = "https://official-lublin-2hub.elenipster.workers.dev/"

# === TEST WINDOW ===
$DATE = "2025-10-31"   # YYYY-MM-DD

# === BASE QUERY (JSON mode, no sheet rows) ===
$BASE = "period=week&days=7&group_times=1&pages=3&limit=1000&sheet=0"

# Helper: GET + parse JSON
function Get-Json($url) {
  $resp = Invoke-WebRequest -UseBasicParsing -Headers @{Accept="application/json"} -Uri $url -Method GET
  $resp.Content | ConvertFrom-Json
}

# Safety: show the 3 base URLs you set
Write-Host "HUB    = $HUB"
Write-Host "ZOOM   = $ZOOM"
Write-Host "OFFICIAL = $OFFICIAL"


----

$zoomUrl = ($ZOOM.TrimEnd('/') + "/?date=$DATE&$BASE")
Write-Host "Zoom URL => $zoomUrl"

# Quick HTTP check (status + small snippet)
$zoomRaw = Invoke-WebRequest -UseBasicParsing -Headers @{Accept="application/json"} -Uri $zoomUrl -Method GET
$zoomRaw.StatusCode
$zoomRaw.Content.Substring(0, [Math]::Min(400, $zoomRaw.Content.Length))

# Parse JSON and peek fields
$zoom = $zoomRaw.Content | ConvertFrom-Json
$zoom | Select-Object source, pages_scanned, budget_used, budget_max, budget_exhausted, count
$zoom.events | Select-Object -First 3 `
  Title, Date, Time, Venue, Category, Link, @{Name='Payment for Entry';Expression={$_.'Payment for Entry'}}, Source, _EndDate
  
  ------
  
$officialUrl = ($OFFICIAL.TrimEnd('/') + "/?date=$DATE&$BASE")
Write-Host "Official URL => $lublinUrl"

$officialRaw = Invoke-WebRequest -UseBasicParsing -Headers @{Accept="application/json"} -Uri $officialUrl -Method GET
$officialRaw.StatusCode
$official = $officialRaw.Content | ConvertFrom-Json
$official | Select-Object source, pages_scanned, budget_used, budget_max, budget_exhausted, count
$official.events | Select-Object -First 3 `
  Title, Date, Time, Venue, Category, Link, @{Name='Payment for Entry';Expression={$_.'Payment for Entry'}}, Source, _EndDate
  
  ---

$hubUrl = ($HUB.TrimEnd('/') + "/?date=$DATE&$BASE")
Write-Host "Hub URL => $hubUrl"

$hubRaw = Invoke-WebRequest -UseBasicParsing -Headers @{Accept="application/json"} -Uri $hubUrl -Method GET
$hub = $hubRaw.Content | ConvertFrom-Json

$hub | Select-Object source, sources_count, received, deduped, count
$hub.per_source | Format-Table source, got, ok, status
$hub.events | Select-Object -First 5 `
  Title, Date, Time, Venue, Category, Source, _EndDate, @{Name='Payment for Entry';Expression={$_.'Payment for Entry'}}, Sources
  