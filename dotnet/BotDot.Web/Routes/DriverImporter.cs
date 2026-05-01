// Importer de drivers desde Excel — port de src/utils/import-drivers.js Node.
//
// Estrategia (acordada con compliance):
//   1. Leer ambos sheets ('Active Drivers', 'Terminated Drivers')
//   2. Match contra drivers existentes (de Samsara sync) por:
//      - CDL # exacto (despues de normalizar)
//      - Nombre fuzzy (Levenshtein con threshold 10% del largo)
//   3. Solo UPDATE compliance fields de los que CRUZAN (estan en Samsara Y Excel)
//   4. Excel-only y Samsara-only quedan en driver_import_discrepancies para review
//
// ClosedXML para parsear xlsx (no SheetJS — el Node migro a exceljs por CVE,
// .NET usa ClosedXML que no tiene esos issues).

using System.Globalization;
using System.Text;
using System.Text.Json;
using BotDot.Web.Data;
using ClosedXML.Excel;
using Dapper;

namespace BotDot.Web.Routes;

public class DriverImporter
{
    private const string SheetActive = "Active Drivers";
    private const string SheetTerminated = "Terminated Drivers";

    private static class Col
    {
        public const string Status = "Status";
        public const string Name = "Employee  Name";          // doble espacio (header real)
        public const string CdlNumber = "CDL #";
        public const string Endorsements = "Endorsements";
        public const string CdlState = "State";
        public const string CdlExpire = "CDL Expire";
        public const string MedExpire = "Medical Card Expire";
        public const string Company = "Company";
        public const string Location = "Location";
        public const string Division = "Division";
        public const string HireDate = "Hire Date ";          // trailing space
        public const string Phone = "Phone";
        public const string Notes = "Notes";
        public const string MoreNotes = "ADDITIONAL NOTES";
    }

    private readonly IDbAccess _db;

    public DriverImporter(IDbAccess db) => _db = db;

    public async Task<ImportResult> RunAsync(string filepath, bool commit, long? importedByUserId = null, CancellationToken ct = default)
    {
        var data = ReadExcel(filepath);
        var allExcel = data.Active.Select(r => (Row: r, Bucket: "active"))
            .Concat(data.Terminated.Select(r => (Row: r, Bucket: "terminated")))
            .ToList();

        var existing = await LoadExistingDriversAsync(ct);
        var matchedIds = new HashSet<long>();

        var summary = new ImportSummary
        {
            ExcelActive = data.Active.Count,
            ExcelTerminated = data.Terminated.Count,
            SamsaraTotal = existing.Count,
        };
        var matches = new List<DriverMatch>();
        var excelOnly = new List<(ExcelRow row, string bucket)>();

        foreach (var (excel, bucket) in allExcel)
        {
            if (string.IsNullOrEmpty(excel.NormName) && string.IsNullOrEmpty(excel.NormCdl))
            {
                summary.SkippedNoNameNoCdl++;
                continue;
            }
            var m = FindMatch(excel, existing);
            if (m != null)
            {
                summary.Matched++;
                if (m.By == "cdl_number") summary.ByCdl++;
                else summary.ByNameFuzzy++;
                matchedIds.Add(m.Match.Id);
                bool active = bucket == "active" &&
                    System.Text.RegularExpressions.Regex.IsMatch(excel.Status ?? "active", @"active", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                matches.Add(new DriverMatch
                {
                    ExcelRow = excel.RowNumber,
                    DriverId = m.Match.Id,
                    ExistingName = m.Match.FullName,
                    ExcelName = excel.FullName,
                    By = m.By,
                    // Confianza: CDL exacto = high, fuzzy name = low.
                    // Compliance debe revisar 'low' antes de definitivo.
                    Confidence = m.By == "cdl_number" ? "high" : "low",
                    Active = active,
                    Excel = excel,
                });
            }
            else
            {
                summary.ExcelOnly++;
                excelOnly.Add((excel, bucket));
            }
        }

        var samsaraOnly = existing
            .Where(e => e.DataSource != "excel" && !matchedIds.Contains(e.Id))
            .ToList();
        summary.SamsaraOnly = samsaraOnly.Count;

        if (!commit)
        {
            return new ImportResult
            {
                Summary = summary,
                MatchesSample = matches.Take(20).ToList(),
                ExcelOnlySample = excelOnly.Take(10).Select(x => x.row).ToList(),
                SamsaraOnlySample = samsaraOnly.Take(10).ToList(),
                Commit = false,
            };
        }

        // ─── Commit transaccional ────────────────────────────────
        var batchId = "imp_" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + "_" + Guid.NewGuid().ToString("N")[..6];
        summary.BatchId = batchId;

        await _db.TransactionAsync<object?>(async (conn, tx) =>
        {
            foreach (var m in matches)
            {
                var newSrc = await GetMergedSourceAsync(conn, tx, m.DriverId);
                await conn.ExecuteAsync(
                    @"UPDATE drivers SET
                        cdl_number = COALESCE(@CdlNumber, cdl_number),
                        cdl_state = COALESCE(@CdlState, cdl_state),
                        cdl_expiration = COALESCE(@CdlExp, cdl_expiration),
                        medical_card_expiration = COALESCE(@MedExp, medical_card_expiration),
                        endorsements = COALESCE(@Endor, endorsements),
                        phone = COALESCE(@Phone, phone),
                        hire_date = COALESCE(@HireDate, hire_date),
                        company = COALESCE(@Company, company),
                        location = COALESCE(@Location, location),
                        division = COALESCE(@Division, division),
                        notes = COALESCE(@Notes, notes),
                        active = @Active,
                        data_source = @DataSource,
                        match_confidence = @Confidence,
                        last_synced_at = CURRENT_TIMESTAMP
                      WHERE id = @Id",
                    new
                    {
                        CdlNumber = m.Excel.CdlNumber,
                        CdlState = m.Excel.CdlState,
                        CdlExp = m.Excel.CdlExpiration,
                        MedExp = m.Excel.MedicalCardExpiration,
                        Endor = m.Excel.Endorsements,
                        Phone = m.Excel.Phone,
                        HireDate = m.Excel.HireDate,
                        Company = m.Excel.Company,
                        Location = m.Excel.Location,
                        Division = m.Excel.Division,
                        Notes = m.Excel.Notes,
                        Active = m.Active ? 1 : 0,
                        DataSource = newSrc,
                        Confidence = m.Confidence,
                        Id = m.DriverId,
                    }, tx);
            }

            await conn.ExecuteAsync("DELETE FROM driver_import_discrepancies", transaction: tx);

            foreach (var (r, bucket) in excelOnly)
            {
                await conn.ExecuteAsync(
                    @"INSERT INTO driver_import_discrepancies
                        (source, full_name, cdl_number, raw_row_json, reason, import_batch)
                      VALUES ('excel_only', @Name, @Cdl, @Raw, @Reason, @Batch)",
                    new
                    {
                        Name = r.FullName,
                        Cdl = r.CdlNumber,
                        Raw = JsonSerializer.Serialize(new
                        {
                            row = r.RowNumber,
                            status = r.Status,
                            bucket = bucket,
                            cdl_expire = r.CdlExpiration,
                            med_expire = r.MedicalCardExpiration,
                        }),
                        Reason = bucket == "terminated"
                            ? "En Excel como Terminated, no esta en Samsara (esperado)"
                            : "En Excel como Active, NO esta en Samsara — verificar si esta trabajando",
                        Batch = batchId,
                    }, tx);
            }

            foreach (var s in samsaraOnly)
            {
                await conn.ExecuteAsync(
                    @"INSERT INTO driver_import_discrepancies
                        (source, full_name, cdl_number, raw_row_json, reason, import_batch)
                      VALUES ('samsara_only', @Name, @Cdl, @Raw, @Reason, @Batch)",
                    new
                    {
                        Name = s.FullName,
                        Cdl = s.CdlNumber,
                        Raw = JsonSerializer.Serialize(new { samsara_id = s.SamsaraId, driver_id = s.Id }),
                        Reason = "En Samsara (activo), NO esta en el Excel de compliance — falta cargar sus datos",
                        Batch = batchId,
                    }, tx);
            }
            return null;
        });

        return new ImportResult
        {
            Summary = summary,
            MatchesCount = matches.Count,
            ExcelOnlyCount = excelOnly.Count,
            SamsaraOnlyCount = samsaraOnly.Count,
            Commit = true,
        };
    }

    private static async Task<string> GetMergedSourceAsync(MySqlConnector.MySqlConnection conn, MySqlConnector.MySqlTransaction tx, long driverId)
    {
        var src = await conn.ExecuteScalarAsync<string?>(
            "SELECT data_source FROM drivers WHERE id = @Id", new { Id = driverId }, tx);
        if (src == "samsara" || src == "samsara+excel") return "samsara+excel";
        return "excel";
    }

    // ─── Read Excel ────────────────────────────────────────────

    private class ExcelData
    {
        public List<ExcelRow> Active { get; } = new();
        public List<ExcelRow> Terminated { get; } = new();
    }

    private static ExcelData ReadExcel(string path)
    {
        var data = new ExcelData();
        using var wb = new XLWorkbook(path);
        ReadSheet(wb, SheetActive, data.Active);
        ReadSheet(wb, SheetTerminated, data.Terminated);
        return data;
    }

    private static void ReadSheet(XLWorkbook wb, string name, List<ExcelRow> bucket)
    {
        if (!wb.Worksheets.TryGetWorksheet(name, out var ws)) return;
        var headerRow = ws.Row(1);
        var headerToCol = new Dictionary<string, int>();
        foreach (var cell in headerRow.CellsUsed())
        {
            var h = cell.GetString();
            if (!string.IsNullOrEmpty(h)) headerToCol[h] = cell.Address.ColumnNumber;
        }
        string CellStr(IXLRow row, string header)
        {
            if (!headerToCol.TryGetValue(header, out var c)) return "";
            var cell = row.Cell(c);
            if (cell.IsEmpty()) return "";
            if (cell.DataType == XLDataType.DateTime) return cell.GetDateTime().ToString("yyyy-MM-dd");
            return cell.GetString().Trim();
        }

        var lastRow = ws.LastRowUsed()?.RowNumber() ?? 1;
        for (int rowNum = 2; rowNum <= lastRow; rowNum++)
        {
            var row = ws.Row(rowNum);
            var name1 = CellStr(row, Col.Name);
            var cdl = CellStr(row, Col.CdlNumber);
            if (string.IsNullOrEmpty(name1) && string.IsNullOrEmpty(cdl)) continue;

            bucket.Add(new ExcelRow
            {
                RowNumber = rowNum,
                Status = CellStr(row, Col.Status),
                FullName = name1,
                CdlNumber = string.IsNullOrEmpty(cdl) ? null : cdl.ToUpperInvariant(),
                Endorsements = NullIfEmpty(CellStr(row, Col.Endorsements)),
                CdlState = NormState(CellStr(row, Col.CdlState)),
                CdlExpiration = ParseDate(CellStr(row, Col.CdlExpire)),
                MedicalCardExpiration = ParseDate(CellStr(row, Col.MedExpire)),
                Company = NullIfEmpty(CellStr(row, Col.Company)),
                Location = NullIfEmpty(CellStr(row, Col.Location)),
                Division = NullIfEmpty(CellStr(row, Col.Division)),
                HireDate = ParseDate(CellStr(row, Col.HireDate)),
                Phone = NullIfEmpty(CellStr(row, Col.Phone)),
                Notes = JoinNotes(CellStr(row, Col.Notes), CellStr(row, Col.MoreNotes)),
                NormName = NormName(name1),
                NormCdl = NormCdl(cdl),
            });
        }
    }

    private static string? NullIfEmpty(string s) => string.IsNullOrEmpty(s) ? null : s;
    private static string? JoinNotes(string a, string b)
    {
        var parts = new[] { a, b }.Where(s => !string.IsNullOrEmpty(s)).Select(s => s.Trim());
        var joined = string.Join(" | ", parts);
        return string.IsNullOrEmpty(joined) ? null : joined;
    }

    // ─── Normalizers (matchea import-drivers.js Node) ──────────

    public static string NormName(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder(s.Normalize(NormalizationForm.FormD));
        // Strip diacriticos (NFD → quitar combining marks)
        var clean = new StringBuilder();
        foreach (var c in sb.ToString())
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
                clean.Append(c);
        }
        var t = clean.ToString().ToLowerInvariant();
        t = System.Text.RegularExpressions.Regex.Replace(t, @"[\*\.,;:#]", " ");
        t = System.Text.RegularExpressions.Regex.Replace(t, @"\s+", " ").Trim();
        return t;
    }

    public static string NormCdl(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return System.Text.RegularExpressions.Regex.Replace(s.ToUpperInvariant(), @"[^A-Z0-9]", "");
    }

    public static string? NormState(string s)
    {
        if (string.IsNullOrEmpty(s)) return null;
        var t = s.Trim();
        if (string.IsNullOrEmpty(t)) return null;
        if (t.Length <= 3) return t.ToUpperInvariant();
        return char.ToUpperInvariant(t[0]) + t[1..].ToLowerInvariant();
    }

    public static string? ParseDate(string? v)
    {
        if (string.IsNullOrEmpty(v)) return null;
        var s = v.Trim();
        var m = System.Text.RegularExpressions.Regex.Match(s, @"^(\d{1,2})/(\d{1,2})/(\d{2,4})$");
        if (m.Success)
        {
            var mo = m.Groups[1].Value;
            var d = m.Groups[2].Value;
            var y = m.Groups[3].Value;
            if (y.Length == 2) y = (int.Parse(y) < 50 ? "20" : "19") + y;
            return $"{y}-{mo.PadLeft(2, '0')}-{d.PadLeft(2, '0')}";
        }
        if (System.Text.RegularExpressions.Regex.IsMatch(s, @"^\d{4}-\d{2}-\d{2}"))
            return s[..10];
        return null;
    }

    // Distancia Levenshtein
    public static int Levenshtein(string a, string b)
    {
        if (a == b) return 0;
        if (a.Length == 0) return b.Length;
        if (b.Length == 0) return a.Length;
        var prev = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++) prev[j] = j;
        for (int i = 1; i <= a.Length; i++)
        {
            var curr = new int[b.Length + 1];
            curr[0] = i;
            for (int j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                curr[j] = Math.Min(Math.Min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            prev = curr;
        }
        return prev[b.Length];
    }

    public static bool NamesMatch(string a, string b)
    {
        if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
        if (a == b) return true;

        // Apellido (ultima palabra) DEBE matchear exacto. Defensa adicional
        // contra falsos positivos como "Robert L Sanchez" ↔ "Roberto Sanchez".
        var partsA = a.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var partsB = b.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (partsA.Length == 0 || partsB.Length == 0) return false;
        if (partsA[^1] != partsB[^1]) return false;

        // Threshold 5% (era 10%, demasiado laxo para nombres cortos).
        var threshold = Math.Max(1, (int)(Math.Min(a.Length, b.Length) * 0.05));
        return Levenshtein(a, b) <= threshold;
    }

    // ─── Match contra existentes ──────────────────────────────

    private async Task<List<ExistingDriver>> LoadExistingDriversAsync(CancellationToken ct)
    {
        var rows = await _db.QueryAsync<ExistingDriver>(
            @"SELECT id AS Id, samsara_id AS SamsaraId, full_name AS FullName,
                     cdl_number AS CdlNumber, data_source AS DataSource
              FROM drivers");
        foreach (var r in rows)
        {
            r.NormName = NormName(r.FullName ?? "");
            r.NormCdl = NormCdl(r.CdlNumber ?? "");
        }
        return rows.ToList();
    }

    private static MatchResult? FindMatch(ExcelRow excel, List<ExistingDriver> existing)
    {
        if (!string.IsNullOrEmpty(excel.NormCdl))
        {
            var byCdl = existing.FirstOrDefault(e => !string.IsNullOrEmpty(e.NormCdl) && e.NormCdl == excel.NormCdl);
            if (byCdl != null) return new MatchResult { Match = byCdl, By = "cdl_number" };
        }
        if (!string.IsNullOrEmpty(excel.NormName))
        {
            var byName = existing.FirstOrDefault(e => NamesMatch(excel.NormName, e.NormName));
            if (byName != null) return new MatchResult { Match = byName, By = "name_fuzzy" };
        }
        return null;
    }

    public class ExcelRow
    {
        public int RowNumber { get; set; }
        public string? Status { get; set; }
        public string? FullName { get; set; }
        public string? CdlNumber { get; set; }
        public string? Endorsements { get; set; }
        public string? CdlState { get; set; }
        public string? CdlExpiration { get; set; }
        public string? MedicalCardExpiration { get; set; }
        public string? Company { get; set; }
        public string? Location { get; set; }
        public string? Division { get; set; }
        public string? HireDate { get; set; }
        public string? Phone { get; set; }
        public string? Notes { get; set; }
        public string NormName { get; set; } = "";
        public string NormCdl { get; set; } = "";
    }

    public class ExistingDriver
    {
        public long Id { get; set; }
        public string? SamsaraId { get; set; }
        public string? FullName { get; set; }
        public string? CdlNumber { get; set; }
        public string? DataSource { get; set; }
        public string NormName { get; set; } = "";
        public string NormCdl { get; set; } = "";
    }

    public class DriverMatch
    {
        public int ExcelRow { get; set; }
        public long DriverId { get; set; }
        public string? ExistingName { get; set; }
        public string? ExcelName { get; set; }
        public string By { get; set; } = "";
        public string Confidence { get; set; } = "low";
        public bool Active { get; set; }
        public ExcelRow Excel { get; set; } = null!;
    }

    private class MatchResult
    {
        public ExistingDriver Match { get; set; } = null!;
        public string By { get; set; } = "";
    }

    public class ImportSummary
    {
        public int ExcelActive { get; set; }
        public int ExcelTerminated { get; set; }
        public int SamsaraTotal { get; set; }
        public int Matched { get; set; }
        public int ExcelOnly { get; set; }
        public int SamsaraOnly { get; set; }
        public int SkippedNoNameNoCdl { get; set; }
        public int ByCdl { get; set; }
        public int ByNameFuzzy { get; set; }
        public string? BatchId { get; set; }
    }

    public class ImportResult
    {
        public ImportSummary Summary { get; set; } = new();
        public bool Commit { get; set; }
        public List<DriverMatch>? MatchesSample { get; set; }
        public List<ExcelRow>? ExcelOnlySample { get; set; }
        public List<ExistingDriver>? SamsaraOnlySample { get; set; }
        public int? MatchesCount { get; set; }
        public int? ExcelOnlyCount { get; set; }
        public int? SamsaraOnlyCount { get; set; }
    }
}
