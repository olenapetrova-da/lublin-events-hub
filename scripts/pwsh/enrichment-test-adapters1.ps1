<#
  Enrichment smoke test (batch-limited) for adapters.
  Examples:
    .\scripts\pwsh\enrichment-test-adapters.ps1 -Date 2025-10-31 `
      -Zoom https://zoom-lublin-2hub.elenipster.workers.dev/ `
      -Official https://official-lublin-2hub.elenipster.workers.dev/ `
      -EnrichMax 10

    # With budget guard:
    .\scripts\pwsh\enrichment-test-adapters.ps1 -Date 2025-10-31 -Budget 6
#>

[CmdletBinding()]
param(
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),

  # Endpoints (defaults to your known workers)
  [string]$Zoom     = $env:ZOOM_ADAPTER     ? $env:ZOOM_ADAPTER     : 'https://zoom-lublin-2hub.elenipster.workers.dev/',
  [string]$Official = $env:OFFICIAL_ADAPTER ? $env:OFFICIAL_ADAPTER : 'https://official-lublin-2hub.elenipster.workers.dev/',

  # Window / paging
  [int]$Pages = 3,
  [int]$Limit = 1000,

  # Enrichment
  [int]$EnrichMax = 10,

  # Optional subrequest budget (0 = let adapter auto-derive)
  [int]$Budget = 0
)

# ---- helpers ----
function Ensure-Endpoint([string]$name, [string]$urlBase) {
  if ([string]::IsNullOrWhiteSpace($urlBase)) { throw "$name is empty. Provide -$name." }
  $u = $urlBase.Trim()
  if (-not $u.StartsWith('http')) { throw "$name must start with http(s)://  (current: '$u')" }
  # ensure exactly one trailing slash
  $u = $u.TrimEnd('/') + '/'
  return $u
}
function Assert-AbsoluteUrl([string]$url) {
  if (-not [Uri]::IsWellFormedUriString($url, [UriKind]::Absolute)) {
    throw "Not a valid absolute URL: $url"
  }
}
function Get-Json([string]$url) {
  # prefer RestMethod to get parsed JSON directly
  Invoke-RestMethod -Headers @{Accept='application/json'} -Uri $url -Method GET
}

# ---- normalize bases ----
$ZoomBase     = Ensure-Endpoint 'Zoom'     $Zoom
$OfficialBase = Ensure-Endpoint 'Official' $Official

# ---- base query for JSON mode (list-first) ----
$BASE = "period=week&days=7&group_times=1&pages=$Pages&limit=$Limit&sheet=0"
$budgetQS = ($Budget -gt 0) ? "&budget=$Budget" : ""

# ================= ZOOM enrichment =================
$zoomEnrichUrl = "$ZoomBase?date=$Date&$BASE&enrich=1&enrich_max=$EnrichMax$budgetQS"
Assert-AbsoluteUrl $zoomEnrichUrl
Write-Host "zoomEnrichUrl     => $zoomEnrichUrl" -ForegroundColor Cyan
$zoomEnrich = Get-Json $zoomEnrichUrl

$zoomEnrich | Select-Object source, enriched, budget_used, budget_max, budget_exhausted, count
$zoomEnrich.events | Select-Object -First 5 `
  Title, @{Name='Payment for Entry';Expression={$_.'Payment for Entry'}}, Time, Venue

# ================= OFFICIAL enrichment =============
$offEnrichUrl = "$OfficialBase?date=$Date&$BASE&enrich=1&enrich_max=$EnrichMax$budgetQS"
Assert-AbsoluteUrl $offEnrichUrl
Write-Host "officialEnrichUrl => $offEnrichUrl" -ForegroundColor Cyan
$offEnrich = Get-Json $offEnrichUrl

$offEnrich | Select-Object source, enriched, budget_used, budget_max, budget_exhausted, count
$offEnrich.events | Select-Object -First 5 `
  Title, @{Name='Payment for Entry';Expression={$_.'Payment for Entry'}}, Time, Venue
