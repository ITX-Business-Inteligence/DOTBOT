$ErrorActionPreference = 'Stop'
$dataDir = 'C:\xampp\htdocs\BOTDOT\data'
$outFile = 'C:\xampp\htdocs\BOTDOT\reports\Reporte_Ejecutivo_USDOT_2195271_2026-04-27.xlsx'

# === 1. CARGAR DATA ===
$viol = Import-Csv (Join-Path $dataDir 'Violation_Summary.csv')
$insp = Import-Csv (Join-Path $dataDir 'Inspections_clean.csv') | Where-Object { $_.Date -and $_.Date.Trim() }
$crash = Import-Csv (Join-Path $dataDir 'Crashes_clean.csv') | Where-Object { $_.Date -and $_.Date.Trim() }

# === 2. AGREGADOS ===

# Per-BASIC totals
$basicTotals = $viol | Group-Object BASIC | ForEach-Object {
  $totalViol = ($_.Group | Measure-Object '# of Violations' -Sum).Sum
  $totalOOS = ($_.Group | Measure-Object '# of OOS Violations' -Sum).Sum
  $totalPoints = ($_.Group | ForEach-Object { [int]$_.'# of Violations' * [int]$_.'Violation Severity Weight' } | Measure-Object -Sum).Sum
  [PSCustomObject]@{
    BASIC = $_.Name
    Violaciones = [int]$totalViol
    OOS = [int]$totalOOS
    OOS_Pct = if ($totalViol) { [math]::Round(($totalOOS/$totalViol)*100,1) } else { 0 }
    Puntos = [int]$totalPoints
    Tipos = $_.Count
  }
} | Sort-Object Puntos -Descending

# Top 25 violations by points
$topViol = $viol | ForEach-Object {
  $cnt = [int]$_.'# of Violations'
  $sev = [int]$_.'Violation Severity Weight'
  $oos = [int]$_.'# of OOS Violations'
  [PSCustomObject]@{
    BASIC = $_.BASIC
    Code = $_.Violation
    Group = $_.'Violation Group Description'
    Description = $_.Descriptions
    Count = $cnt
    OOS = $oos
    Sev = $sev
    Points = $cnt * $sev
  }
} | Sort-Object Points -Descending | Select-Object -First 25

# Monthly trend with proxy score
# Score proxy = sum of (SevWeight + 2*OOS) * TimeWeight per violation row
$monthly = @{}
foreach ($r in $insp) {
  if (-not $r.Code -or $r.Code.Trim() -eq '') { continue }
  $d = $null
  try { $d = [DateTime]$r.Date } catch { continue }
  $key = $d.ToString('yyyy-MM')
  $sev = 0; [int]::TryParse($r.SevWeight, [ref]$sev) | Out-Null
  $tw = 0; [int]::TryParse($r.TimeWeight, [ref]$tw) | Out-Null
  $oosBonus = if ($r.OOS -eq 'Yes') { 2 } else { 0 }
  $pts = ($sev + $oosBonus) * $tw
  if (-not $monthly.ContainsKey($key)) {
    $monthly[$key] = @{ TotalPts=0 }
  }
  $monthly[$key].TotalPts += $pts
  if (-not $monthly[$key].ContainsKey($r.BASIC)) { $monthly[$key][$r.BASIC] = 0 }
  $monthly[$key][$r.BASIC] += $pts
}

# Monthly inspection counts (unique by Number)
$monthlyInsp = @{}
$seen = @{}
foreach ($r in $insp) {
  if ($seen.ContainsKey($r.Number)) { continue }
  $seen[$r.Number] = $true
  try { $d = [DateTime]$r.Date } catch { continue }
  $key = $d.ToString('yyyy-MM')
  if (-not $monthlyInsp.ContainsKey($key)) { $monthlyInsp[$key] = @{Insp=0; OOS=0; Clean=0} }
  $monthlyInsp[$key].Insp++
  $hasViol = $insp | Where-Object { $_.Number -eq $r.Number -and $_.Code -and $_.Code.Trim() -ne '' }
  if (-not $hasViol) {
    $monthlyInsp[$key].Clean++
  } else {
    $isOOS = $hasViol | Where-Object { $_.OOS -eq 'Yes' }
    if ($isOOS) { $monthlyInsp[$key].OOS++ }
  }
}

$months = ($monthly.Keys + $monthlyInsp.Keys | Sort-Object -Unique)
$basicNames = @('Unsafe Driving','HOS Compliance','Driver Fitness','Drugs/Alcohol','Vehicle Maint.')

$monthlyTable = foreach ($m in $months) {
  $row = [ordered]@{ Mes = $m }
  $i = if ($monthlyInsp.ContainsKey($m)) { $monthlyInsp[$m] } else { @{Insp=0; OOS=0; Clean=0} }
  $row.Inspecciones = [int]$i.Insp
  $row.OOS = [int]$i.OOS
  $row.Clean = [int]$i.Clean
  $row.OOS_Pct = if ($i.Insp) { [math]::Round(($i.OOS/$i.Insp)*100,1) } else { 0 }
  $row.Clean_Pct = if ($i.Insp) { [math]::Round(($i.Clean/$i.Insp)*100,1) } else { 0 }
  foreach ($b in $basicNames) {
    $key = if ($b -eq 'Vehicle Maint.') { 'Vehicle Maint.' } else { $b }
    $val = if ($monthly.ContainsKey($m) -and $monthly[$m].ContainsKey($key)) { $monthly[$m][$key] } else { 0 }
    $row[$b] = [int]$val
  }
  $row.Total_Pts = if ($monthly.ContainsKey($m)) { [int]$monthly[$m].TotalPts } else { 0 }
  [PSCustomObject]$row
}

# State analysis
$stateAnalysis = $insp | Group-Object Number | ForEach-Object {
  $first = $_.Group[0]
  $hasOOS = $_.Group | Where-Object { $_.OOS -eq 'Yes' }
  $hasViol = $_.Group | Where-Object { $_.Code -and $_.Code.Trim() -ne '' }
  [PSCustomObject]@{ State=$first.State; HasOOS=[bool]$hasOOS; HasViol=[bool]$hasViol }
} | Group-Object State | ForEach-Object {
  $oos = ($_.Group | Where-Object { $_.HasOOS }).Count
  $clean = ($_.Group | Where-Object { -not $_.HasViol }).Count
  [PSCustomObject]@{
    Estado = $_.Name
    Inspecciones = $_.Count
    Con_Violacion = $_.Count - $clean
    OOS = $oos
    Clean = $clean
    OOS_Pct = if ($_.Count) { [math]::Round(($oos/$_.Count)*100,1) } else { 0 }
    Clean_Pct = if ($_.Count) { [math]::Round(($clean/$_.Count)*100,1) } else { 0 }
  }
} | Sort-Object Inspecciones -Descending

# Crash analysis
$crashRows = $crash | ForEach-Object {
  $fatNum = 0; [int]::TryParse($_.Fatalities, [ref]$fatNum) | Out-Null
  $injNum = 0; [int]::TryParse($_.Injuries, [ref]$injNum) | Out-Null
  $sevNum = 0; [int]::TryParse($_.SevWeight, [ref]$sevNum) | Out-Null
  $twNum = 0; [int]::TryParse($_.TimeWeight, [ref]$twNum) | Out-Null
  $tsNum = 0; [int]::TryParse($_.TimeSevWeight, [ref]$tsNum) | Out-Null
  $np = if ($_.NotPreventable -and $_.NotPreventable.Trim() -ne '') { $_.NotPreventable } else { '(no flag)' }
  [PSCustomObject]@{
    Fecha = $_.Date
    Estado = $_.State
    Reporte = $_.Number
    Fatales = $fatNum
    Lesionados = $injNum
    TowAway = $_.TowAway
    Severidad = $sevNum
    TimeWeight = $twNum
    PuntosCrash = $tsNum
    NotPreventable = $np
    DataQs_Candidato = if ($np -ne 'Yes') { 'SI - revisar' } else { 'No (ya excluido)' }
  }
}

# Save aggregates as CSV for traceability
$basicTotals | Export-Csv (Join-Path $dataDir 'agg_basic.csv') -NoTypeInformation -Encoding UTF8
$topViol | Export-Csv (Join-Path $dataDir 'agg_top_viol.csv') -NoTypeInformation -Encoding UTF8
$monthlyTable | Export-Csv (Join-Path $dataDir 'agg_monthly.csv') -NoTypeInformation -Encoding UTF8
$stateAnalysis | Export-Csv (Join-Path $dataDir 'agg_state.csv') -NoTypeInformation -Encoding UTF8
$crashRows | Export-Csv (Join-Path $dataDir 'agg_crashes.csv') -NoTypeInformation -Encoding UTF8

Write-Output "Aggregates done. Months: $($months.Count). BASICs: $($basicTotals.Count)."
Write-Output "Total points by BASIC:"
$basicTotals | Format-Table -AutoSize | Out-String | Write-Output