$ErrorActionPreference = 'Stop'
$dataDir = 'C:\xampp\htdocs\BOTDOT\data'
$outFile = 'C:\xampp\htdocs\BOTDOT\reports\Reporte_Ejecutivo_USDOT_2195271_2026-04-27.xlsx'

if (Test-Path $outFile) { Remove-Item $outFile -Force }

$xlLineMarkers = 65
$xlColumnClustered = 51
$xlBarStacked = 58
$xlBarClustered = 57
$xlPie = 5

$basicP = Import-Csv (Join-Path $dataDir 'agg_basic_with_percentile.csv')
$top = Import-Csv (Join-Path $dataDir 'agg_top_viol.csv')
$mo = Import-Csv (Join-Path $dataDir 'agg_monthly.csv')
$st = Import-Csv (Join-Path $dataDir 'agg_state.csv')
$cr = Import-Csv (Join-Path $dataDir 'agg_crashes.csv')

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Add()
while ($wb.Sheets.Count -gt 1) { $wb.Sheets.Item($wb.Sheets.Count).Delete() }

function Set-Header($range, $bold=$true, $fontSize=11, $colorBg=$null, $colorFg=$null) {
  $range.Font.Name = 'Calibri'
  $range.Font.Size = $fontSize
  $range.Font.Bold = $bold
  if ($colorBg) { $range.Interior.Color = $colorBg }
  if ($colorFg) { $range.Font.Color = $colorFg }
}

function Add-Table($ws, $startRow, $startCol, $headers, $data, $widths) {
  $r = $startRow
  for ($c = 0; $c -lt $headers.Count; $c++) {
    $cell = $ws.Cells.Item($r, $startCol + $c)
    $cell.Value2 = [string]$headers[$c]
    if ($widths -and $c -lt $widths.Count) {
      $ws.Columns.Item($startCol + $c).ColumnWidth = $widths[$c]
    }
  }
  $hdrRange = $ws.Range($ws.Cells.Item($r, $startCol), $ws.Cells.Item($r, $startCol + $headers.Count - 1))
  Set-Header $hdrRange $true 11 0x1F4E78 0xFFFFFF
  $hdrRange.HorizontalAlignment = -4108
  $r++
  $firstDataRow = $r
  foreach ($row in $data) {
    for ($c = 0; $c -lt $headers.Count; $c++) {
      $val = $row.PSObject.Properties[$headers[$c]].Value
      $cell = $ws.Cells.Item($r, $startCol + $c)
      if ($val -is [int] -or $val -is [long] -or $val -is [double]) {
        $cell.Value2 = [double]$val
      } elseif ($val -match '^-?\d+$') {
        $cell.Value2 = [double]$val
      } elseif ($val -match '^-?\d+\.\d+$') {
        $cell.Value2 = [double]$val
      } else {
        $cell.Value2 = [string]$val
      }
    }
    $r++
  }
  $lastDataRow = $r - 1
  if ($lastDataRow -ge $firstDataRow) {
    $bodyRange = $ws.Range($ws.Cells.Item($firstDataRow, $startCol), $ws.Cells.Item($lastDataRow, $startCol + $headers.Count - 1))
    $bodyRange.Font.Name = 'Calibri'
    $bodyRange.Font.Size = 10
    $bodyRange.Borders.LineStyle = 1
    $bodyRange.Borders.Weight = 2
  }
  return @{ FirstRow=$firstDataRow; LastRow=$lastDataRow; LastCol=($startCol + $headers.Count - 1) }
}

# =========================================================
# SHEET 1: Resumen Ejecutivo
# =========================================================
$ws1 = $wb.Sheets.Item(1)
$ws1.Name = 'Resumen Ejecutivo'
$ws1.Tab.Color = 0x1F4E78

$ws1.Cells.Item(1,1).Value2 = 'REPORTE EJECUTIVO DE COMPLIANCE DOT'
Set-Header $ws1.Range('A1:H1') $true 18 0x1F4E78 0xFFFFFF
$ws1.Range('A1:H1').Merge()
$ws1.Range('A1:H1').HorizontalAlignment = -4108
$ws1.Rows.Item(1).RowHeight = 30

$ws1.Cells.Item(2,1).Value2 = 'USDOT 2195271 - Snapshot SMS al 27-marzo-2026 - Ventana 24 meses'
Set-Header $ws1.Range('A2:H2') $false 11
$ws1.Range('A2:H2').Merge()
$ws1.Range('A2:H2').HorizontalAlignment = -4108

$ws1.Cells.Item(3,1).Value2 = "Generado: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | Fuente: SMS Public Download + Carrier Overview percentiles"
Set-Header $ws1.Range('A3:H3') $false 9
$ws1.Range('A3:H3').Merge()
$ws1.Range('A3:H3').HorizontalAlignment = -4108
$ws1.Range('A3:H3').Font.Italic = $true

# KPI cards - now with REAL alert info
$kpiRow = 5
$kpis = @(
  @{Label='BASICs en Alert'; Value='4 de 7'; Note='HOS, DF, VM, Crash'; Color=0xC00000},
  @{Label='Score Maximo'; Value='98'; Note='Driver Fitness (top 2%)'; Color=0xC00000},
  @{Label='Meses en Alert (max)'; Value='26'; Note='HOS y Driver Fitness'; Color=0xC00000},
  @{Label='Crashes (24m)'; Value='47'; Note='4 fatales / 18 lesionados'; Color=0x808080}
)
for ($i = 0; $i -lt $kpis.Count; $i++) {
  $col = 1 + ($i * 2)
  $ws1.Cells.Item($kpiRow, $col).Value2 = [string]$kpis[$i].Label
  $ws1.Cells.Item($kpiRow + 1, $col).Value2 = [string]$kpis[$i].Value
  $ws1.Cells.Item($kpiRow + 2, $col).Value2 = [string]$kpis[$i].Note
  $rng = $ws1.Range($ws1.Cells.Item($kpiRow, $col), $ws1.Cells.Item($kpiRow, $col + 1))
  $rng.Merge()
  $rng2 = $ws1.Range($ws1.Cells.Item($kpiRow + 1, $col), $ws1.Cells.Item($kpiRow + 1, $col + 1))
  $rng2.Merge()
  $rng3 = $ws1.Range($ws1.Cells.Item($kpiRow + 2, $col), $ws1.Cells.Item($kpiRow + 2, $col + 1))
  $rng3.Merge()
  $box = $ws1.Range($ws1.Cells.Item($kpiRow, $col), $ws1.Cells.Item($kpiRow + 2, $col + 1))
  $box.Borders.LineStyle = 1
  $box.Borders.Weight = 3
  Set-Header $ws1.Cells.Item($kpiRow, $col) $true 10 0xE7E6E6
  $valCell = $ws1.Cells.Item($kpiRow + 1, $col)
  Set-Header $valCell $true 22 $null $kpis[$i].Color
  Set-Header $ws1.Cells.Item($kpiRow + 2, $col) $false 9
  $ws1.Cells.Item($kpiRow + 2, $col).Font.Italic = $true
  $box.HorizontalAlignment = -4108
}

# Estado por BASIC con percentiles reales
$hr = 10
$ws1.Cells.Item($hr,1).Value2 = 'ESTADO REAL POR BASIC (percentiles FMCSA SMS)'
Set-Header $ws1.Range("A${hr}:H${hr}") $true 14 0x1F4E78 0xFFFFFF
$ws1.Range("A${hr}:H${hr}").Merge()
$hr++

$basicSorted = $basicP | Sort-Object { [int]$_.Score_Pct } -Descending
$headersStatus = @('BASIC','Score_Pct','Threshold','Gap','Alert','MonthsInAlert','Violaciones','OOS_Pct')
$resStatus = Add-Table $ws1 $hr 1 $headersStatus $basicSorted @(28,11,11,8,9,16,12,10)
# Color rows by alert
for ($r = $resStatus.FirstRow; $r -le $resStatus.LastRow; $r++) {
  $alertCell = $ws1.Cells.Item($r, 5)
  if ($alertCell.Value2 -eq 'Alert') {
    $rowRange = $ws1.Range($ws1.Cells.Item($r, 1), $ws1.Cells.Item($r, 8))
    $rowRange.Interior.Color = 0xCCCCFF  # light red
    $rowRange.Font.Color = 0x000080  # dark red
    $rowRange.Font.Bold = $true
  }
}
$hr = $resStatus.LastRow + 2

# Hallazgos
$ws1.Cells.Item($hr,1).Value2 = 'HALLAZGOS CRITICOS'
Set-Header $ws1.Range("A${hr}:H${hr}") $true 14 0xC00000 0xFFFFFF
$ws1.Range("A${hr}:H${hr}").Merge()
$hr++

$findings = @(
  '1. CRITICO: 4 de 7 BASICs en Alert simultaneamente - candidato directo para FMCSA Compliance Review (CR)',
  '2. Driver Fitness en 98% (top 2% peor) con 26 meses cronico - 48 violaciones de operating without CDL',
  '3. HOS en 91% con 26 meses cronico - patron sistematico de False Logs (33 viol) y abuso Personal Conveyance',
  '4. Vehicle Maintenance en 89% con 19 meses cronico - lamparas, ABS lamps, periodic inspection paperwork',
  '5. Crash Indicator escalando (71%, 9 meses Alert) con 47 crashes y CERO disputados via DataQs',
  '6. RIESGO INMEDIATO: una CR encuentra Acute/Critical violations en estos patrones = Conditional Safety Rating'
)
foreach ($f in $findings) {
  $ws1.Cells.Item($hr, 1).Value2 = [string]$f
  $rng = $ws1.Range("A${hr}:H${hr}")
  $rng.Merge()
  Set-Header $ws1.Cells.Item($hr,1) $false 11
  $hr++
}

$hr++
$ws1.Cells.Item($hr,1).Value2 = 'NOTA: Los percentiles fueron capturados del FMCSA Carrier Overview (https://ai.fmcsa.dot.gov/SMS/Carrier/2195271). Thresholds usados son los de carrier general (no passenger ni HM). Este reporte NO constituye asesoria legal - consultar abogado de transporte y/o compliance officer certificado antes de actuar.'
$ws1.Range("A${hr}:H${hr}").Merge()
$ws1.Range("A${hr}:H${hr}").WrapText = $true
$ws1.Range("A${hr}:H${hr}").Font.Italic = $true
$ws1.Range("A${hr}:H${hr}").Font.Size = 9
$ws1.Rows.Item($hr).RowHeight = 50

# =========================================================
# SHEET 2: Riesgo de Intervencion (NUEVA)
# =========================================================
$ws_risk = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws1)
$ws_risk.Name = 'Riesgo de Intervencion'
$ws_risk.Tab.Color = 0xC00000

$ws_risk.Cells.Item(1,1).Value2 = 'EVALUACION DE RIESGO REGULATORIO FMCSA'
Set-Header $ws_risk.Range('A1:G1') $true 16 0xC00000 0xFFFFFF
$ws_risk.Range('A1:G1').Merge()
$ws_risk.Range('A1:G1').HorizontalAlignment = -4108
$ws_risk.Rows.Item(1).RowHeight = 28

$ws_risk.Cells.Item(2,1).Value2 = 'Lectura de los percentiles vs umbrales de intervencion FMCSA y consecuencias regulatorias probables'
$ws_risk.Range('A2:G2').Merge()
$ws_risk.Range('A2:G2').Font.Italic = $true

# Tabla de gap por BASIC
$ws_risk.Cells.Item(4,1).Value2 = 'GAP CONTRA UMBRAL POR BASIC'
Set-Header $ws_risk.Range('A4:G4') $true 12 0x1F4E78 0xFFFFFF
$ws_risk.Range('A4:G4').Merge()

$riskHeaders = @('BASIC','Score_Pct','Threshold','Gap','Alert','MonthsInAlert','Violaciones')
$resRisk = Add-Table $ws_risk 5 1 $riskHeaders ($basicP | Sort-Object { [int]$_.MonthsInAlert } -Descending) @(28,11,11,8,9,16,12)
for ($r = $resRisk.FirstRow; $r -le $resRisk.LastRow; $r++) {
  $alert = $ws_risk.Cells.Item($r, 5).Value2
  $months = $ws_risk.Cells.Item($r, 6).Value2
  if ($alert -eq 'Alert') {
    $rowRange = $ws_risk.Range($ws_risk.Cells.Item($r, 1), $ws_risk.Cells.Item($r, 7))
    if ($months -ge 18) {
      $rowRange.Interior.Color = 0x6B6BFF
      $rowRange.Font.Color = 0xFFFFFF
    } else {
      $rowRange.Interior.Color = 0xCCCCFF
    }
    $rowRange.Font.Bold = $true
  }
}

# Chart - bar de gap
$chartRisk = $ws_risk.ChartObjects().Add(550, 60, 600, 350)
$chartRisk.Chart.ChartType = $xlBarClustered
$gapAddr = "A$($resRisk.FirstRow):A$($resRisk.LastRow),D$($resRisk.FirstRow):D$($resRisk.LastRow)"
$chartRisk.Chart.SetSourceData($ws_risk.Range($gapAddr))
$chartRisk.Chart.HasTitle = $true
$chartRisk.Chart.ChartTitle.Text = 'Gap vs Umbral (positivo = sobre umbral = Alert)'

# Consecuencias regulatorias
$rr = $resRisk.LastRow + 3
$ws_risk.Cells.Item($rr,1).Value2 = 'CONSECUENCIAS REGULATORIAS PROBABLES'
Set-Header $ws_risk.Range("A${rr}:G${rr}") $true 12 0x1F4E78 0xFFFFFF
$ws_risk.Range("A${rr}:G${rr}").Merge()
$rr++

$consequences = @(
  [PSCustomObject]@{Riesgo='Compliance Review (CR) presencial'; Probabilidad='ALTA'; Trigger='Multi-BASIC alert + cronico (26m HOS y DF)'; Plazo_Estimado='3-12 meses'; Mitigacion='Auditoria interna anticipada de DQ file y RODS antes que llegue FMCSA'},
  [PSCustomObject]@{Riesgo='Conditional Safety Rating'; Probabilidad='ALTA si CR'; Trigger='Acute violations en CR (probable: 383.23a2, 395.8e patron)'; Plazo_Estimado='Post-CR (60 dias)'; Mitigacion='Eliminar Acute candidates ANTES de la CR'},
  [PSCustomObject]@{Riesgo='Targeted Roadside Enforcement (CSE)'; Probabilidad='YA OCURRIENDO'; Trigger='Cuatro BASICs en alert prioriza inspecciones'; Plazo_Estimado='Continuo'; Mitigacion='Pre-trip estricto y ELP screening interno'},
  [PSCustomObject]@{Riesgo='Out-of-Service Order'; Probabilidad='MEDIA'; Trigger='Acute en CR (drug program, falsificacion RODS sistematica)'; Plazo_Estimado='Post-CR'; Mitigacion='Programa drug & alcohol revisado, eliminar PC abuse'},
  [PSCustomObject]@{Riesgo='Insurance hike / no renewal'; Probabilidad='ALTA'; Trigger='Brokers leen percentiles publicos cada renewal'; Plazo_Estimado='Proxima renovacion'; Mitigacion='Bajar al menos 1 BASIC fuera de alert antes de renewal'},
  [PSCustomObject]@{Riesgo='Perdida de cuentas / shipper auditing'; Probabilidad='ALTA'; Trigger='Shippers usan SAFER y SMS para vendor scoring'; Plazo_Estimado='Proximas RFPs'; Mitigacion='Plan de remediacion documentado para mostrar a shippers'},
  [PSCustomObject]@{Riesgo='Civil penalties por violaciones repetidas'; Probabilidad='MEDIA'; Trigger='Patron documentado en CR (ej. 26m alert HOS)'; Plazo_Estimado='Post-CR'; Mitigacion='Documentar plan de correccion y entrenamiento por driver'}
)
$consHeaders = @('Riesgo','Probabilidad','Trigger','Plazo_Estimado','Mitigacion')
$resCons = Add-Table $ws_risk $rr 1 $consHeaders $consequences @(35,15,55,18,55)
for ($r = $resCons.FirstRow; $r -le $resCons.LastRow; $r++) {
  $ws_risk.Rows.Item($r).RowHeight = 38
  for ($c = 1; $c -le 5; $c++) { $ws_risk.Cells.Item($r, $c).WrapText = $true }
  $prob = $ws_risk.Cells.Item($r, 2).Value2
  if ($prob -eq 'ALTA' -or $prob -like 'YA*') {
    $ws_risk.Cells.Item($r, 2).Interior.Color = 0x0000C0
    $ws_risk.Cells.Item($r, 2).Font.Color = 0xFFFFFF
    $ws_risk.Cells.Item($r, 2).Font.Bold = $true
  } elseif ($prob -like 'MEDIA*' -or $prob -like 'ALTA si*') {
    $ws_risk.Cells.Item($r, 2).Interior.Color = 0x00A5FF
    $ws_risk.Cells.Item($r, 2).Font.Bold = $true
  }
}

# =========================================================
# SHEET 3: Tendencia Score
# =========================================================
$ws2 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws_risk)
$ws2.Name = 'Tendencia Score'
$ws2.Tab.Color = 0xC00000

$ws2.Cells.Item(1,1).Value2 = 'TENDENCIA MENSUAL - PROXY SCORE INTERNO POR BASIC'
Set-Header $ws2.Range('A1:I1') $true 14 0x1F4E78 0xFFFFFF
$ws2.Range('A1:I1').Merge()
$ws2.Range('A1:I1').HorizontalAlignment = -4108

$ws2.Cells.Item(2,1).Value2 = 'Score interno = SUM((SeverityWeight + 2*OOS) x TimeWeight) por mes. Es el numerador del SMS antes de normalizar.'
$ws2.Range('A2:I2').Merge()
$ws2.Range('A2:I2').Font.Italic = $true
$ws2.Range('A2:I2').Font.Size = 9

$headers = @('Mes','Unsafe Driving','HOS Compliance','Driver Fitness','Drugs/Alcohol','Vehicle Maint.','Total_Pts')
$res = Add-Table $ws2 4 1 $headers $mo @(10,16,16,16,14,16,12)

$chartObj = $ws2.ChartObjects().Add(550, 60, 750, 380)
$chart = $chartObj.Chart
$chart.ChartType = $xlLineMarkers
$dataRange = $ws2.Range($ws2.Cells.Item(4,1), $ws2.Cells.Item($res.LastRow, 6))
$chart.SetSourceData($dataRange)
$chart.HasTitle = $true
$chart.ChartTitle.Text = 'Score Mensual por BASIC (puntos)'

$chartObj2 = $ws2.ChartObjects().Add(550, 460, 750, 280)
$chart2 = $chartObj2.Chart
$chart2.ChartType = $xlLineMarkers
$comboAddr = "A4:A$($res.LastRow),G4:G$($res.LastRow)"
$chart2.SetSourceData($ws2.Range($comboAddr))
$chart2.HasTitle = $true
$chart2.ChartTitle.Text = 'Score Total Mensual'

# =========================================================
# SHEET 4: Tendencia Inspecciones
# =========================================================
$ws3 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws2)
$ws3.Name = 'Tendencia Inspecciones'
$ws3.Tab.Color = 0xC00000

$ws3.Cells.Item(1,1).Value2 = 'TENDENCIA MENSUAL - INSPECCIONES, OOS Y CLEAN'
Set-Header $ws3.Range('A1:G1') $true 14 0x1F4E78 0xFFFFFF
$ws3.Range('A1:G1').Merge()
$ws3.Range('A1:G1').HorizontalAlignment = -4108

$headers3 = @('Mes','Inspecciones','OOS','Clean','OOS_Pct','Clean_Pct')
$res3 = Add-Table $ws3 3 1 $headers3 $mo @(10,14,8,8,12,12)

$chartObj3 = $ws3.ChartObjects().Add(450, 40, 700, 350)
$chartObj3.Chart.ChartType = $xlColumnClustered
$rng3 = $ws3.Range($ws3.Cells.Item(3,1), $ws3.Cells.Item($res3.LastRow, 4))
$chartObj3.Chart.SetSourceData($rng3)
$chartObj3.Chart.HasTitle = $true
$chartObj3.Chart.ChartTitle.Text = 'Inspecciones por Mes'

$chartObj4 = $ws3.ChartObjects().Add(450, 410, 700, 320)
$chartObj4.Chart.ChartType = $xlLineMarkers
$comboAddr2 = "A3:A$($res3.LastRow),E3:F$($res3.LastRow)"
$chartObj4.Chart.SetSourceData($ws3.Range($comboAddr2))
$chartObj4.Chart.HasTitle = $true
$chartObj4.Chart.ChartTitle.Text = 'OOS % vs Clean % Mensual'

# =========================================================
# SHEET 5: BASICs (con percentiles reales)
# =========================================================
$ws4 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws3)
$ws4.Name = 'BASICs Score'
$ws4.Tab.Color = 0xFFC000

$ws4.Cells.Item(1,1).Value2 = 'BASICs - SCORE OFICIAL FMCSA Y MEDIDAS INTERNAS'
Set-Header $ws4.Range('A1:K1') $true 14 0x1F4E78 0xFFFFFF
$ws4.Range('A1:K1').Merge()
$ws4.Range('A1:K1').HorizontalAlignment = -4108

$bHeaders = @('BASIC','Violaciones','OOS','OOS_Pct','Puntos','Measure','Score_Pct','Threshold','Gap','Alert','MonthsInAlert')
$resB = Add-Table $ws4 3 1 $bHeaders ($basicP | Sort-Object { [int]$_.Score_Pct } -Descending) @(26,12,8,10,10,10,10,10,8,9,15)
for ($r = $resB.FirstRow; $r -le $resB.LastRow; $r++) {
  if ($ws4.Cells.Item($r, 10).Value2 -eq 'Alert') {
    $row = $ws4.Range($ws4.Cells.Item($r, 1), $ws4.Cells.Item($r, 11))
    $row.Interior.Color = 0xCCCCFF
    $row.Font.Bold = $true
  }
}

# Chart - score vs threshold
$chartObjScore = $ws4.ChartObjects().Add(20, ($resB.LastRow * 18 + 80), 700, 340)
$chartObjScore.Chart.ChartType = $xlBarClustered
$scoreAddr = "A$($resB.FirstRow):A$($resB.LastRow),G$($resB.FirstRow):H$($resB.LastRow)"
$chartObjScore.Chart.SetSourceData($ws4.Range($scoreAddr))
$chartObjScore.Chart.HasTitle = $true
$chartObjScore.Chart.ChartTitle.Text = 'Score Actual vs Umbral por BASIC'

$chartObjPie = $ws4.ChartObjects().Add(740, ($resB.LastRow * 18 + 80), 480, 340)
$chartObjPie.Chart.ChartType = $xlPie
$ptsAddr = "A$($resB.FirstRow):A$($resB.LastRow),E$($resB.FirstRow):E$($resB.LastRow)"
$chartObjPie.Chart.SetSourceData($ws4.Range($ptsAddr))
$chartObjPie.Chart.HasTitle = $true
$chartObjPie.Chart.ChartTitle.Text = 'Puntos Internos por BASIC'

# =========================================================
# SHEET 6: Top Violaciones
# =========================================================
$ws5 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws4)
$ws5.Name = 'Top Violaciones'
$ws5.Tab.Color = 0xFFC000

$ws5.Cells.Item(1,1).Value2 = 'TOP 25 VIOLACIONES POR PUNTOS (Pareto 80/20)'
Set-Header $ws5.Range('A1:H1') $true 14 0x1F4E78 0xFFFFFF
$ws5.Range('A1:H1').Merge()
$ws5.Range('A1:H1').HorizontalAlignment = -4108

$headers5 = @('BASIC','Code','Group','Description','Count','OOS','Sev','Points')
$res5 = Add-Table $ws5 3 1 $headers5 $top @(16,14,22,55,8,7,7,10)
for ($r = $res5.FirstRow; $r -le $res5.LastRow; $r++) {
  $ws5.Rows.Item($r).RowHeight = 28
  $ws5.Cells.Item($r, 4).WrapText = $true
}

$chartObj7 = $ws5.ChartObjects().Add(20, ($res5.LastRow * 30 + 80), 1100, 380)
$chartObj7.Chart.ChartType = $xlBarStacked
$top15 = 15
$lastRow15 = $res5.FirstRow + $top15 - 1
$combo3Addr = "B$($res5.FirstRow):B$($lastRow15),H$($res5.FirstRow):H$($lastRow15)"
$chartObj7.Chart.SetSourceData($ws5.Range($combo3Addr))
$chartObj7.Chart.HasTitle = $true
$chartObj7.Chart.ChartTitle.Text = 'Top 15 Violaciones por Puntos'

# =========================================================
# SHEET 7: Estados
# =========================================================
$ws6 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws5)
$ws6.Name = 'Estados'
$ws6.Tab.Color = 0x00B050

$ws6.Cells.Item(1,1).Value2 = 'ANALISIS POR ESTADO'
Set-Header $ws6.Range('A1:G1') $true 14 0x1F4E78 0xFFFFFF
$ws6.Range('A1:G1').Merge()
$ws6.Range('A1:G1').HorizontalAlignment = -4108

$headers6 = @('Estado','Inspecciones','Con_Violacion','OOS','Clean','OOS_Pct','Clean_Pct')
$top20States = $st | Select-Object -First 20
$res6 = Add-Table $ws6 3 1 $headers6 $top20States @(10,14,16,8,8,12,12)

$chartObj8 = $ws6.ChartObjects().Add(550, 40, 650, 400)
$chartObj8.Chart.ChartType = $xlColumnClustered
$comboStAddr = "A3:B$($res6.LastRow),D3:D$($res6.LastRow)"
$chartObj8.Chart.SetSourceData($ws6.Range($comboStAddr))
$chartObj8.Chart.HasTitle = $true
$chartObj8.Chart.ChartTitle.Text = 'Inspecciones y OOS por Estado'

# =========================================================
# SHEET 8: Crashes
# =========================================================
$ws7 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws6)
$ws7.Name = 'Crashes'
$ws7.Tab.Color = 0xC00000

$ws7.Cells.Item(1,1).Value2 = 'CRASHES 24 MESES - CANDIDATOS DataQs'
Set-Header $ws7.Range('A1:K1') $true 14 0x1F4E78 0xFFFFFF
$ws7.Range('A1:K1').Merge()
$ws7.Range('A1:K1').HorizontalAlignment = -4108

$ws7.Cells.Item(2,1).Value2 = 'Crashes "SI - revisar" deben evaluarse para potencial DataQs / Not Preventable. Cero disputados actualmente.'
$ws7.Range('A2:K2').Merge()
$ws7.Range('A2:K2').Font.Italic = $true
$ws7.Range('A2:K2').Font.Size = 9

$headers7 = @('Fecha','Estado','Reporte','Fatales','Lesionados','TowAway','Severidad','TimeWeight','PuntosCrash','NotPreventable','DataQs_Candidato')
$res7 = Add-Table $ws7 4 1 $headers7 $cr @(11,8,16,9,11,9,11,11,12,14,18)

for ($r = $res7.FirstRow; $r -le $res7.LastRow; $r++) {
  $cell = $ws7.Cells.Item($r, 11)
  if ($cell.Value2 -like 'SI*') {
    $rowRange = $ws7.Range($ws7.Cells.Item($r, 1), $ws7.Cells.Item($r, 11))
    $rowRange.Interior.Color = 0xCCFFFF
  }
}

# =========================================================
# SHEET 9: Plan de Accion - REORDENADO POR RIESGO REGULATORIO
# =========================================================
$ws8 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws7)
$ws8.Name = 'Plan de Accion'
$ws8.Tab.Color = 0x00B050

$ws8.Cells.Item(1,1).Value2 = 'PLAN DE ACCION - PRIORIZADO POR RIESGO DE CR / CONDITIONAL RATING'
Set-Header $ws8.Range('A1:H1') $true 14 0x1F4E78 0xFFFFFF
$ws8.Range('A1:H1').Merge()
$ws8.Range('A1:H1').HorizontalAlignment = -4108

$ws8.Cells.Item(2,1).Value2 = 'Orden por mitigacion de Acute/Critical violations probables en una CR, NO solo por puntos. Apunta a sacar BASICs del estado de Alert.'
$ws8.Range('A2:H2').Merge()
$ws8.Range('A2:H2').Font.Italic = $true
$ws8.Range('A2:H2').Font.Size = 9

$plan = @(
  [PSCustomObject]@{Prioridad='1 - EMERGENCIA';     BASIC='Driver Fitness'; Audiencia='Compliance + HR';    Accion='Audit DQ file + Clearinghouse query x driver. Sacar de operacion drivers sin CDL valido inmediatamente'; Impacto_Pts=384; CFR='383.23(a)(2), 391.51, Clearinghouse'; Plazo='7 dias'; KPI='0 drivers operando sin CDL valido'},
  [PSCustomObject]@{Prioridad='2 - EMERGENCIA';     BASIC='HOS';            Audiencia='Compliance + Dispatch'; Accion='Auditoria sistematica de RODS - identificar drivers con patron PC abuse y False Logs. Plan de correccion x driver';    Impacto_Pts=189; CFR='395.8(e), 395.8(e)(1)PC';      Plazo='14 dias'; KPI='False log violations <2 por trimestre'},
  [PSCustomObject]@{Prioridad='3 - PREPARAR CR';    BASIC='Multi';          Audiencia='Compliance';            Accion='Auditoria interna estilo CR antes que llegue FMCSA. Documentar correctivos para mostrar buena fe';                  Impacto_Pts=0;   CFR='49 CFR 385';                   Plazo='30 dias'; KPI='Carpeta de correctivos lista para FMCSA'},
  [PSCustomObject]@{Prioridad='4 - QUICK WIN';      BASIC='Crash Indicator'; Audiencia='Compliance';           Accion='DataQs sweep - revisar 47 crashes y disputar preventables incorrectos';                                              Impacto_Pts=100; CFR='SMS Methodology';              Plazo='60 dias'; KPI='Crashes Not-Preventable aprobados'},
  [PSCustomObject]@{Prioridad='5 - QUICK WIN';      BASIC='Driver Fitness'; Audiencia='Compliance + HR';      Accion='Programa ELP screening interno antes de despachar (Memo MC-SEE-2025-0001) - entrevista + sign assessment';          Impacto_Pts=124; CFR='391.11(b)(2)';                Plazo='30 dias'; KPI='0 OOS por ELP en 90d'},
  [PSCustomObject]@{Prioridad='6 - OPERACIONAL';    BASIC='Vehicle Maint';  Audiencia='Dispatch + Driver';    Accion='Pre-trip con foto obligatoria (lamparas, llantas, ABS, periodic inspection) antes de salir de yard';               Impacto_Pts=440; CFR='392.7, 396.13';                Plazo='Inmediato'; KPI='Reduccion 50% violaciones 393.9 en 60d'},
  [PSCustomObject]@{Prioridad='7 - OPERACIONAL';    BASIC='Vehicle Maint';  Audiencia='Maintenance';          Accion='Tire management program - inspeccion semanal de presion y tread depth. Auditoria de proveedores de llantas';        Impacto_Pts=240; CFR='393.75';                       Plazo='60 dias'; KPI='Tire OOS rate <2%'},
  [PSCustomObject]@{Prioridad='8 - OPERACIONAL';    BASIC='Vehicle Maint';  Audiencia='Compliance';           Accion='Garantizar copia de periodic inspection (annual) en CADA cabina';                                                    Impacto_Pts=152; CFR='396.17(c), 396.21';            Plazo='Inmediato'; KPI='100% unidades con annual'},
  [PSCustomObject]@{Prioridad='9 - SUPERVISION';    BASIC='Multi';          Audiencia='Supervisor';           Accion='Coaching driver-by-driver para top 10 drivers con mas puntos. Re-training documentado';                              Impacto_Pts=0;   CFR='-';                            Plazo='Continuo'; KPI='Reduccion 30% violaciones por driver'},
  [PSCustomObject]@{Prioridad='10 - GOVERNANCE';    BASIC='Multi';          Audiencia='Manager';              Accion='Dashboard mensual de score vs umbral en junta de operaciones. Tracking de meses-en-Alert';                          Impacto_Pts=0;   CFR='-';                            Plazo='Mensual'; KPI='Score trending downward 3 meses consecutivos'},
  [PSCustomObject]@{Prioridad='11 - COMUNICACION';  BASIC='Multi';          Audiencia='Manager';              Accion='Plan de remediacion documentado para shippers, brokers, y aseguradora antes proxima renovacion';                    Impacto_Pts=0;   CFR='-';                            Plazo='Pre-renewal'; KPI='Renovacion sin hike'}
)

$headers8 = @('Prioridad','BASIC','Audiencia','Accion','Impacto_Pts','CFR','Plazo','KPI')
$res8 = Add-Table $ws8 4 1 $headers8 $plan @(16,16,18,55,12,22,12,30)
for ($r = $res8.FirstRow; $r -le $res8.LastRow; $r++) {
  $ws8.Rows.Item($r).RowHeight = 38
  $ws8.Cells.Item($r, 4).WrapText = $true
  $ws8.Cells.Item($r, 6).WrapText = $true
  $ws8.Cells.Item($r, 8).WrapText = $true
  $pri = $ws8.Cells.Item($r, 1).Value2
  if ($pri -like '*EMERGENCIA*') {
    $ws8.Cells.Item($r, 1).Interior.Color = 0x0000C0
    $ws8.Cells.Item($r, 1).Font.Color = 0xFFFFFF
    $ws8.Cells.Item($r, 1).Font.Bold = $true
  } elseif ($pri -like '*PREPARAR*' -or $pri -like '*QUICK*') {
    $ws8.Cells.Item($r, 1).Interior.Color = 0x00A5FF
    $ws8.Cells.Item($r, 1).Font.Bold = $true
  } else {
    $ws8.Cells.Item($r, 1).Interior.Color = 0x90EE90
  }
}

$wb.Sheets.Item(1).Activate()
$wb.SaveAs($outFile, 51)
$wb.Close($true)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

Write-Output "REPORTE V2 GENERADO: $outFile"
Write-Output ("Tamano: " + [math]::Round((Get-Item $outFile).Length / 1KB, 1) + " KB")