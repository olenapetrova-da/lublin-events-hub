# == Adapter enrichment sanity check (small batch) ==

# === REAL ENDPOINTS  ===
$HUB     = "https://lublin-events-hub.elenipster.workers.dev/"
$ZOOM    = "https://zoom-lublin-2hub.elenipster.workers.dev/"
$OFFICIAL= "https://official-lublin-2hub.elenipster.workers.dev/"

# === TEST WINDOW ===
$DATE = "2025-11-01"   # YYYY-MM-DD

# === BASE QUERY (JSON mode, no sheet rows) ===
$BASE = "period=week&days=7&group_times=1&pages=3&limit=1000&sheet=0"

# Helper: GET + parse JSON
function Get-Json($url) {
  $resp = Invoke-WebRequest -UseBasicParsing -Headers @{Accept="application/json"} -Uri $url -Method GET
  $resp.Content | ConvertFrom-Json
}

# Safety: show the 3 base URLs you set
Write-Host "HUB      = $HUB"
Write-Host "ZOOM     = $ZOOM"
Write-Host "OFFICIAL = $OFFICIAL"

# === Zoom with enrichment ===
$zoomEnrichUrl = ($ZOOM.TrimEnd('/') + "/?date=$DATE&$BASE&enrich=1&enrich_max=10")
$zoomEnrich = Get-Json $zoomEnrichUrl

$zoomEnrich | Select-Object source, enriched, budget_used, budget_max, budget_exhausted, count
$zoomEnrich.events | Select-Object -First 5 `
  Title, @{Name='Payment for Entry';Expression={$_.'Payment for Entry'}}, Time, Venue

# === Official with enrichment ===
$officialEnrichUrl = ($OFFICIAL.TrimEnd('/') + "/?date=$DATE&$BASE&enrich=1&enrich_max=10")
$officialEnrich = Get-Json $officialEnrichUrl

$officialEnrich | Select-Object source, enriched, budget_used, budget_max, budget_exhausted, count
$officialEnrich.events | Select-Object -First 5 `
  Title, @{Name='Payment for Entry';Expression={$_.'Payment for Entry'}}, Time, Venue
