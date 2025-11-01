# == Hub smoke (list-only refresh) + pass-through enrichment ==

# === REAL ENDPOINTS  ===
$HUB     = "https://lublin-events-hub.elenipster.workers.dev/"
$DATE    = "2025-11-01"   # YYYY-MM-DD
$BASE    = "period=week&days=7&group_times=1&pages=3&limit=1000&sheet=0"

function Get-Json($url) {
  $resp = Invoke-WebRequest -UseBasicParsing -Headers @{Accept="application/json"} -Uri $url -Method GET
  $resp.Content | ConvertFrom-Json
}

# === Hub refresh (list-only; full 7-day coverage) ===
$hubRefreshUrl = ($HUB.TrimEnd('/') + "/?date=$DATE&$BASE")
$hubRefresh = Get-Json $hubRefreshUrl

$hubRefresh | Select-Object source, received, deduped, count
$hubRefresh.per_source | Format-Table source, got, ok, status

# === Hub enrichment (small batch pass-through) ===
$hubEnrichUrl = ($HUB.TrimEnd('/') + "/?date=$DATE&$BASE&enrich=1&enrich_max=15")
$hubEnrich = Get-Json $hubEnrichUrl

$hubEnrich | Select-Object source, received, deduped, count
$hubEnrich.per_source | Format-Table source, got, ok, status

# Optional: quick visibility into remaining empties from the hub response
($hubEnrich.events | Where-Object { -not $_.'Payment for Entry' }).Count
$hubEnrich.events | Where-Object { -not $_.'Payment for Entry' } |
  Select-Object -First 5 Title, Link
