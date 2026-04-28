$ErrorActionPreference = 'Stop'
$dataDir = 'C:\xampp\htdocs\BOTDOT\data'
$outFile = 'C:\xampp\htdocs\BOTDOT\reports\Reporte_Ejecutivo_USDOT_2195271_2026-04-27.xlsx'

if (Test-Path $outFile) { Remove-Item $outFile -Force }

# Excel constants
$xlLineMarkers = 65
$xlColumnClustered = 51
$xlBarStacked = 58
$xlLine = 4
$xlAreaStacked = 76
$xlPie = 5

$basic = Import-Csv (Join-Path $dataDir 'agg_basic.csv')
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
    $cell.Value2 = $headers[$c]
    if ($widths -and $c -lt $widths.Count) {
      $ws.Columns.Item($startCol + $c).ColumnWidth = $widths[$c]
    }
  }
  $hdrRange = $ws.Range($ws.Cells.Item($r, $startCol), $ws.Cells.Item($r, $startCol + $headers.Count - 1))
  Set-Header $hdrRange $true 11 0x1F4E78 0xFFFFFF
  $hdrRange.HorizontalAlignment = -4108  # center
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

$ws1.Cells.Item(3,1).Value2 = "Generado: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | Fuente: SMS Public Download"
Set-Header $ws1.Range('A3:H3') $false 9
$ws1.Range('A3:H3').Merge()
$ws1.Range('A3:H3').HorizontalAlignment = -4108
$ws1.Range('A3:H3').Font.Italic = $true

# KPI cards
$kpiRow = 5
$kpis = @(
  @{Label='Inspecciones (24m)'; Value=903; Note=''},
  @{Label='Clean Rate'; Value='44.4%'; Note='Benchmark: 70%+'},
  @{Label='Crashes (24m)'; Value=47; Note='4 fatales / 18 lesionados'},
  @{Label='OOS Rate'; Value='15.2%'; Note='Benchmark: <13%'}
)
for ($i = 0; $i -lt $kpis.Count; $i++) {
  $col = 1 + ($i * 2)
  $cell = $ws1.Cells.Item($kpiRow, $col)
  $cell.Value2 = [string]$kpis[$i].Label
  $valCell = $ws1.Cells.Item($kpiRow + 1, $col)
  $valCell.Value2 = [string]$kpis[$i].Value
  $noteCell = $ws1.Cells.Item($kpiRow + 2, $col)
  $noteCell.Value2 = [string]$kpis[$i].Note
  $rng = $ws1.Range($ws1.Cells.Item($kpiRow, $col), $ws1.Cells.Item($kpiRow, $col + 1))
  $rng.Merge()
  $rng2 = $ws1.Range($ws1.Cells.Item($kpiRow + 1, $col), $ws1.Cells.Item($kpiRow + 1, $col + 1))
  $rng2.Merge()
  $rng3 = $ws1.Range($ws1.Cells.Item($kpiRow + 2, $col), $ws1.Cells.Item($kpiRow + 2, $col + 1))
  $rng3.Merge()
  $rng = $ws1.Range($ws1.Cells.Item($kpiRow, $col), $ws1.Cells.Item($kpiRow + 2, $col + 1))
  $rng.Borders.LineStyle = 1
  $rng.Borders.Weight = 3
  Set-Header $ws1.Cells.Item($kpiRow, $col) $true 10 0xE7E6E6
  Set-Header $valCell $true 22
  Set-Header $noteCell $false 9
  $valCell.Font.Italic = $false
  $noteCell.Font.Italic = $true
  $rng.HorizontalAlignment = -4108
}

# Hallazgos clave
$hr = 10
$ws1.Cells.Item($hr,1).Value2 = 'HALLAZGOS CLAVE'
Set-Header $ws1.Range("A${hr}:H${hr}") $true 14 0x1F4E78 0xFFFFFF
$ws1.Range("A${hr}:H${hr}").Merge()
$hr++

$findings = @(
  '1. Vehicle Maintenance domina por puntos absolutos (2,453 pts / 60% del peso total)',
  '2. Driver Fitness es la categoria mas peligrosa: 81% de violaciones son OOS - riesgo de intervencion inmediata',
  '3. CRITICO: 48 violaciones de "Operating CMV without CDL" (383.23a2) - falla del DQ file',
  '4. Tendencia adversa: Nov-2025 (29.9% OOS), Feb-2026 (29.5% OOS), Mar-2026 (22.6%)',
  '5. 47 crashes con CERO disputados via DataQs - oportunidad inmediata de remover preventables del SMS',
  '6. 78% de inspecciones ocurren en TX (OOS rate 18.2%) - revision de rutas y dispatch'
)
foreach ($f in $findings) {
  $ws1.Cells.Item($hr, 1).Value2 = $f
  $rng = $ws1.Range("A${hr}:H${hr}")
  $rng.Merge()
  Set-Header $ws1.Cells.Item($hr,1) $false 11
  $hr++
}

$hr++
$ws1.Cells.Item($hr,1).Value2 = 'TOP 5 PALANCAS DE MEJORA (impacto estimado en puntos SMS)'
Set-Header $ws1.Range("A${hr}:H${hr}") $true 14 0x1F4E78 0xFFFFFF
$ws1.Range("A${hr}:H${hr}").Merge()
$hr++

$tableData = @(
  [PSCustomObject]@{Accion='Auditoria emergente del DQ File - validar CDL en Clearinghouse'; Impacto='-384 pts'; CFR='49 CFR 383.23, 391.51'; Plazo='30 dias'},
  [PSCustomObject]@{Accion='DataQs sweep - disputar crashes preventables incorrectos'; Impacto='Hasta -100 pts'; CFR='SMS Methodology'; Plazo='60 dias'},
  [PSCustomObject]@{Accion='Pre-trip con foto obligatoria (lamparas, ABS, periodic inspection)'; Impacto='-440 pts'; CFR='49 CFR 392.7, 396.13'; Plazo='Inmediato'},
  [PSCustomObject]@{Accion='Programa de ELP screening (FMCSA Memo MC-SEE-2025-0001)'; Impacto='-124 pts'; CFR='49 CFR 391.11(b)(2)'; Plazo='30 dias'},
  [PSCustomObject]@{Accion='Auditoria de RODS / abuso Personal Conveyance'; Impacto='-189 pts'; CFR='49 CFR 395.8(e)'; Plazo='45 dias'}
)
Add-Table $ws1 $hr 1 @('Accion','Impacto','CFR','Plazo') $tableData @(70, 18, 28, 12) | Out-Null
$hr += $tableData.Count + 1

$hr += 2
$ws1.Cells.Item($hr,1).Value2 = 'NOTA: El "score" mostrado en este reporte es un proxy SMS-aligned (severity x time weight, +2 OOS bonus). Los percentiles oficiales requieren la version Login del SMS o consultar https://ai.fmcsa.dot.gov/SMS directamente. Este reporte NO constituye asesoria legal.'
$ws1.Range("A${hr}:H${hr}").Merge()
$ws1.Range("A${hr}:H${hr}").WrapText = $true
$ws1.Range("A${hr}:H${hr}").Font.Italic = $true
$ws1.Range("A${hr}:H${hr}").Font.Size = 9
$ws1.Rows.Item($hr).RowHeight = 40

# =========================================================
# SHEET 2: Tendencia Score por BASIC
# =========================================================
$ws2 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws1)
$ws2.Name = 'Tendencia Score'
$ws2.Tab.Color = 0xC00000

$ws2.Cells.Item(1,1).Value2 = 'TENDENCIA MENSUAL - PROXY SCORE SMS POR BASIC'
Set-Header $ws2.Range('A1:I1') $true 14 0x1F4E78 0xFFFFFF
$ws2.Range('A1:I1').Merge()
$ws2.Range('A1:I1').HorizontalAlignment = -4108

$ws2.Cells.Item(2,1).Value2 = 'Score = SUM((SeverityWeight + 2*OOS) x TimeWeight) por mes. Cuanto mas alto, peor.'
$ws2.Range('A2:I2').Merge()
$ws2.Range('A2:I2').Font.Italic = $true
$ws2.Range('A2:I2').Font.Size = 9

$headers = @('Mes','Unsafe Driving','HOS Compliance','Driver Fitness','Drugs/Alcohol','Vehicle Maint.','Total_Pts')
$res = Add-Table $ws2 4 1 $headers $mo @(10,16,16,16,14,16,12)

# Line chart - score por BASIC
$chartObj = $ws2.ChartObjects().Add(550, 60, 750, 380)
$chart = $chartObj.Chart
$chart.ChartType = $xlLineMarkers
$dataRange = $ws2.Range($ws2.Cells.Item(4,1), $ws2.Cells.Item($res.LastRow, 6))
$chart.SetSourceData($dataRange)
$chart.HasTitle = $true
$chart.ChartTitle.Text = 'Score Mensual por BASIC (puntos)'
$chart.ChartTitle.Font.Size = 14
$chart.ChartTitle.Font.Bold = $true

# Total line chart abajo
$chartObj2 = $ws2.ChartObjects().Add(550, 460, 750, 280)
$chart2 = $chartObj2.Chart
$chart2.ChartType = $xlLineMarkers
$comboAddr = "A4:A$($res.LastRow),G4:G$($res.LastRow)"
$combo = $ws2.Range($comboAddr)
$chart2.SetSourceData($combo)
$chart2.HasTitle = $true
$chart2.ChartTitle.Text = 'Score Total Mensual (todos los BASICs)'
$chart2.ChartTitle.Font.Size = 14
$chart2.ChartTitle.Font.Bold = $true

# =========================================================
# SHEET 3: Tendencia Inspecciones (OOS% y Clean%)
# =========================================================
$ws3 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws2)
$ws3.Name = 'Tendencia Inspecciones'
$ws3.Tab.Color = 0xC00000

$ws3.Cells.Item(1,1).Value2 = 'TENDENCIA MENSUAL - INSPECCIONES, OOS% Y CLEAN%'
Set-Header $ws3.Range('A1:G1') $true 14 0x1F4E78 0xFFFFFF
$ws3.Range('A1:G1').Merge()
$ws3.Range('A1:G1').HorizontalAlignment = -4108

$headers3 = @('Mes','Inspecciones','OOS','Clean','OOS_Pct','Clean_Pct')
$res3 = Add-Table $ws3 3 1 $headers3 $mo @(10,14,8,8,12,12)

# Chart counts
$chartObj3 = $ws3.ChartObjects().Add(450, 40, 700, 350)
$chart3 = $chartObj3.Chart
$chart3.ChartType = $xlColumnClustered
$rng3 = $ws3.Range($ws3.Cells.Item(3,1), $ws3.Cells.Item($res3.LastRow, 4))
$chart3.SetSourceData($rng3)
$chart3.HasTitle = $true
$chart3.ChartTitle.Text = 'Inspecciones por Mes (totales / con OOS / clean)'

# Chart percent
$chartObj4 = $ws3.ChartObjects().Add(450, 410, 700, 320)
$chart4 = $chartObj4.Chart
$chart4.ChartType = $xlLineMarkers
$comboAddr2 = "A3:A$($res3.LastRow),E3:F$($res3.LastRow)"
$combo2 = $ws3.Range($comboAddr2)
$chart4.SetSourceData($combo2)
$chart4.HasTitle = $true
$chart4.ChartTitle.Text = 'OOS % vs Clean % Mensual'

# =========================================================
# SHEET 4: Pareto por BASIC
# =========================================================
$ws4 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws3)
$ws4.Name = 'Pareto BASIC'
$ws4.Tab.Color = 0xFFC000

$ws4.Cells.Item(1,1).Value2 = 'DISTRIBUCION DE PUNTOS POR BASIC'
Set-Header $ws4.Range('A1:F1') $true 14 0x1F4E78 0xFFFFFF
$ws4.Range('A1:F1').Merge()
$ws4.Range('A1:F1').HorizontalAlignment = -4108

$headers4 = @('BASIC','Violaciones','OOS','OOS_Pct','Puntos','Tipos')
$res4 = Add-Table $ws4 3 1 $headers4 $basic @(20,14,8,12,12,8)

$chartObj5 = $ws4.ChartObjects().Add(450, 40, 600, 380)
$chart5 = $chartObj5.Chart
$chart5.ChartType = $xlBarStacked
$comboBasicAddr = "A3:A$($res4.LastRow),E3:E$($res4.LastRow)"
$comboBasic = $ws4.Range($comboBasicAddr)
$chart5.SetSourceData($comboBasic)
$chart5.HasTitle = $true
$chart5.ChartTitle.Text = 'Puntos Totales por BASIC (24m)'

$chartObj6 = $ws4.ChartObjects().Add(450, 440, 600, 300)
$chart6 = $chartObj6.Chart
$chart6.ChartType = $xlPie
$chart6.SetSourceData($ws4.Range($comboBasicAddr))
$chart6.HasTitle = $true
$chart6.ChartTitle.Text = 'Distribucion % por BASIC'

# =========================================================
# SHEET 5: Top 25 Violaciones
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
$ws5.Cells.Item(3,1).EntireRow.RowHeight = 30
for ($r = $res5.FirstRow; $r -le $res5.LastRow; $r++) {
  $ws5.Rows.Item($r).RowHeight = 28
  $ws5.Cells.Item($r, 4).WrapText = $true
}

# Bar chart of top 15 by points
$chartObj7 = $ws5.ChartObjects().Add(20, ($res5.LastRow * 30 + 80), 1100, 380)
$chart7 = $chartObj7.Chart
$chart7.ChartType = $xlBarStacked
$top15 = 15
$lastRow15 = $res5.FirstRow + $top15 - 1
$combo3Addr = "B$($res5.FirstRow):B$($lastRow15),H$($res5.FirstRow):H$($lastRow15)"
$combo3 = $ws5.Range($combo3Addr)
$chart7.SetSourceData($combo3)
$chart7.HasTitle = $true
$chart7.ChartTitle.Text = 'Top 15 Violaciones por Puntos'

# =========================================================
# SHEET 6: Estados
# =========================================================
$ws6 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws5)
$ws6.Name = 'Estados'
$ws6.Tab.Color = 0x00B050

$ws6.Cells.Item(1,1).Value2 = 'ANALISIS DE INSPECCIONES POR ESTADO'
Set-Header $ws6.Range('A1:G1') $true 14 0x1F4E78 0xFFFFFF
$ws6.Range('A1:G1').Merge()
$ws6.Range('A1:G1').HorizontalAlignment = -4108

$headers6 = @('Estado','Inspecciones','Con_Violacion','OOS','Clean','OOS_Pct','Clean_Pct')
$top20States = $st | Select-Object -First 20
$res6 = Add-Table $ws6 3 1 $headers6 $top20States @(10,14,16,8,8,12,12)

$chartObj8 = $ws6.ChartObjects().Add(550, 40, 650, 400)
$chart8 = $chartObj8.Chart
$chart8.ChartType = $xlColumnClustered
$comboStAddr = "A3:B$($res6.LastRow),D3:D$($res6.LastRow)"
$comboSt = $ws6.Range($comboStAddr)
$chart8.SetSourceData($comboSt)
$chart8.HasTitle = $true
$chart8.ChartTitle.Text = 'Inspecciones y OOS por Estado'

# =========================================================
# SHEET 7: Crashes
# =========================================================
$ws7 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws6)
$ws7.Name = 'Crashes'
$ws7.Tab.Color = 0xC00000

$ws7.Cells.Item(1,1).Value2 = 'CRASHES 24 MESES - CANDIDATOS DataQs'
Set-Header $ws7.Range('A1:K1') $true 14 0x1F4E78 0xFFFFFF
$ws7.Range('A1:K1').Merge()
$ws7.Range('A1:K1').HorizontalAlignment = -4108

$ws7.Cells.Item(2,1).Value2 = 'Crashes marcados "SI - revisar" deben evaluarse para potencial DataQs / Not Preventable.'
$ws7.Range('A2:K2').Merge()
$ws7.Range('A2:K2').Font.Italic = $true
$ws7.Range('A2:K2').Font.Size = 9

$headers7 = @('Fecha','Estado','Reporte','Fatales','Lesionados','TowAway','Severidad','TimeWeight','PuntosCrash','NotPreventable','DataQs_Candidato')
$res7 = Add-Table $ws7 4 1 $headers7 $cr @(11,8,16,9,11,9,11,11,12,14,18)

# Conditional formatting - resaltar SI revisar
for ($r = $res7.FirstRow; $r -le $res7.LastRow; $r++) {
  $cell = $ws7.Cells.Item($r, 11)
  if ($cell.Value2 -like 'SI*') {
    $rowRange = $ws7.Range($ws7.Cells.Item($r, 1), $ws7.Cells.Item($r, 11))
    $rowRange.Interior.Color = 0xCCFFFF
  }
}

# =========================================================
# SHEET 8: Plan de Accion
# =========================================================
$ws8 = $wb.Sheets.Add([System.Reflection.Missing]::Value, $ws7)
$ws8.Name = 'Plan de Accion'
$ws8.Tab.Color = 0x00B050

$ws8.Cells.Item(1,1).Value2 = 'PLAN DE ACCION PRIORIZADO'
Set-Header $ws8.Range('A1:G1') $true 14 0x1F4E78 0xFFFFFF
$ws8.Range('A1:G1').Merge()
$ws8.Range('A1:G1').HorizontalAlignment = -4108

$plan = @(
  [PSCustomObject]@{P=1; Audiencia='Compliance'; Accion='Auditoria DQ file - verificar CDL valido en Clearinghouse para CADA driver activo'; Impacto_Pts=384; CFR='383.23(a)(2), 391.51'; Plazo='30 dias'; KPI='0 violaciones 383.23a2 en 90 dias'},
  [PSCustomObject]@{P=2; Audiencia='Compliance'; Accion='Sweep DataQs - revisar 47 crashes y disputar preventables incorrectos'; Impacto_Pts=100; CFR='SMS Methodology'; Plazo='60 dias'; KPI='Crashes Not-Preventable aprobados'},
  [PSCustomObject]@{P=3; Audiencia='Dispatch+Driver'; Accion='Pre-trip con foto obligatoria (lamparas, llantas, ABS) antes de salir de yard'; Impacto_Pts=440; CFR='392.7, 396.13'; Plazo='Inmediato'; KPI='Reduccion 50% violaciones 393.9 en 60d'},
  [PSCustomObject]@{P=4; Audiencia='Compliance+HR'; Accion='Programa ELP screening interno antes de despachar (Memo MC-SEE-2025-0001)'; Impacto_Pts=124; CFR='391.11(b)(2)'; Plazo='30 dias'; KPI='0 OOS por ELP en 90d'},
  [PSCustomObject]@{P=5; Audiencia='Compliance+Dispatch'; Accion='Auditoria de RODS - identificar drivers con patron de Personal Conveyance abuse'; Impacto_Pts=189; CFR='395.8(e), 395.8(e)(1)'; Plazo='45 dias'; KPI='False log violations <2 por trimestre'},
  [PSCustomObject]@{P=6; Audiencia='Maintenance'; Accion='Programa de tire management con inspeccion semanal (presion, tread depth)'; Impacto_Pts=240; CFR='393.75'; Plazo='60 dias'; KPI='Tire OOS rate <2%'},
  [PSCustomObject]@{P=7; Audiencia='Compliance'; Accion='Garantizar copia del periodic inspection (annual) en CADA cabina'; Impacto_Pts=152; CFR='396.17(c), 396.21'; Plazo='Inmediato'; KPI='100% unidades con copia del annual'},
  [PSCustomObject]@{P=8; Audiencia='Supervisor'; Accion='Coaching driver-by-driver para top 10 drivers con mas puntos'; Impacto_Pts=0; CFR='-'; Plazo='Continuo'; KPI='Reduccion 30% violaciones por driver'},
  [PSCustomObject]@{P=9; Audiencia='Manager'; Accion='Dashboard mensual de score vs benchmark - revision en junta de operaciones'; Impacto_Pts=0; CFR='-'; Plazo='Mensual'; KPI='Score trending downward 3 meses consecutivos'}
)

$headers8 = @('P','Audiencia','Accion','Impacto_Pts','CFR','Plazo','KPI')
$res8 = Add-Table $ws8 3 1 $headers8 $plan @(5,18,55,12,18,12,30)
for ($r = $res8.FirstRow; $r -le $res8.LastRow; $r++) {
  $ws8.Rows.Item($r).RowHeight = 32
  $ws8.Cells.Item($r, 3).WrapText = $true
  $ws8.Cells.Item($r, 7).WrapText = $true
}

# =========================================================
# SAVE
# =========================================================
$wb.Sheets.Item(1).Activate()
$wb.SaveAs($outFile, 51)  # xlOpenXMLWorkbook
$wb.Close($true)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

Write-Output "REPORTE GENERADO: $outFile"
Write-Output ("Tamano: " + [math]::Round((Get-Item $outFile).Length / 1KB, 1) + " KB")