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



$zoomEnrichUrl = ($ZOOM.TrimEnd('/') + "/?date=$DATE&$BASE&enrich=1&enrich_max=10")
Write-Host "<$zoomEnrichUrl>"   # quick visual check, angle brackets reveal stray spaces
$zoomEnrich = Get-Json $zoomEnrichUrl
$zoomEnrich | Select source, enriched, budget_used, budget_max, budget_exhausted, count
$zoomEnrich.events | Select -First 5 Title, @{N='Payment for Entry';E={$_.('Payment for Entry')}}, Time, Venue
  

  
$officialEnrichUrl = ($OFFICIAL.TrimEnd('/') + "/?date=$DATE&$BASE&enrich=1&enrich_max=10")
Write-Host "<$officialEnrichUrl>"
$officialEnrich = Get-Json $officialEnrichUrl
$officialEnrich | Select source, enriched, budget_used, budget_max, budget_exhausted, count
$officialEnrich.events | Select -First 5 Title, @{N='Payment for Entry';E={$_.('Payment for Entry')}}, Time, Venue