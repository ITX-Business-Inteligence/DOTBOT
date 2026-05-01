// Verificacion de la cadena de audit. Recorre filas en orden ASC, recalcula
// row_hash y compara contra el stored, y verifica que prev_hash = row_hash
// de la fila anterior.
//
// Equivalente al verifyChain() del Node + paginacion M7 (cap MAX_ROWS_PER_REQUEST).

using System.Text.Json;
using BotDot.Web.Data;
using Dapper;

namespace BotDot.Web.Audit;

public class AuditVerifyOptions
{
    public long? From { get; set; }
    public long? To { get; set; }
}

public class ChainIssue
{
    public long AuditId { get; set; }
    public string Type { get; set; } = "";  // "broken_link" | "hash_mismatch"
    public string? ExpectedPrevHash { get; set; }
    public string? ActualPrevHash { get; set; }
    public string? StoredRowHash { get; set; }
    public string? RecomputedRowHash { get; set; }
}

public class ChainVerifyResult
{
    public int RowsChecked { get; set; }
    public bool Intact { get; set; }
    public string HeadHash { get; set; } = "";
    public long? HeadAuditId { get; set; }
    public List<ChainIssue> Issues { get; set; } = new();
    public bool RangeCapped { get; set; }
}

public class ChainHeadInfo
{
    public long? AuditId { get; set; }
    public string RowHash { get; set; } = "";
    public DateTime? CreatedAt { get; set; }
}

public class AuditVerifier
{
    private readonly IDbAccess _db;

    public AuditVerifier(IDbAccess db) => _db = db;

    public async Task<ChainHeadInfo> GetHeadAsync()
    {
        await using var conn = _db.GetConnection();
        var row = await conn.QueryFirstOrDefaultAsync<dynamic>(
            "SELECT id, row_hash, created_at FROM audit_log ORDER BY id DESC LIMIT 1");
        if (row == null)
        {
            return new ChainHeadInfo { AuditId = null, RowHash = AuditService.GenesisHash, CreatedAt = null };
        }
        return new ChainHeadInfo
        {
            AuditId = (long)row.id,
            RowHash = (string)row.row_hash,
            CreatedAt = (DateTime?)row.created_at,
        };
    }

    public async Task<ChainVerifyResult> VerifyAsync(AuditVerifyOptions opts)
    {
        var clauses = new List<string>();
        var args = new DynamicParameters();
        if (opts.From.HasValue) { clauses.Add("id >= @From"); args.Add("From", opts.From.Value); }
        if (opts.To.HasValue)   { clauses.Add("id <= @To");   args.Add("To",   opts.To.Value); }
        var where = clauses.Count > 0 ? "WHERE " + string.Join(" AND ", clauses) : "";

        await using var conn = _db.GetConnection();
        var rows = (await conn.QueryAsync<RawAuditRow>(
            $@"SELECT id AS Id, user_id AS UserId, conversation_id AS ConversationId,
                      action_type AS ActionType, subject_type AS SubjectType, subject_id AS SubjectId,
                      decision AS Decision, cfr_cited AS CfrCited, reasoning AS Reasoning,
                      evidence_json AS EvidenceJson, override_reason AS OverrideReason,
                      created_at AS CreatedAt, prev_hash AS PrevHash, row_hash AS RowHash
               FROM audit_log
               {where}
               ORDER BY id ASC", args)).AsList();

        var result = new ChainVerifyResult();
        // Si arrancamos desde el principio, el primer prev_hash debe ser GENESIS.
        // Si arrancamos en medio, no podemos validar el primer link (no tenemos
        // el row_hash de la fila id-1).
        string? expectedPrev = opts.From.HasValue ? null : AuditService.GenesisHash;

        foreach (var r in rows)
        {
            // 1. Verificar el link: prev_hash matchea row_hash anterior
            if (expectedPrev != null && r.PrevHash != expectedPrev)
            {
                result.Issues.Add(new ChainIssue
                {
                    AuditId = r.Id,
                    Type = "broken_link",
                    ExpectedPrevHash = expectedPrev,
                    ActualPrevHash = r.PrevHash,
                });
            }

            // 2. Recalcular row_hash y comparar con stored
            var createdAtIso = TruncateToSecondsIso(r.CreatedAt);
            var hashable = BuildHashableFromDb(r, createdAtIso, r.PrevHash);
            var canonical = Canonicalize.Serialize(hashable);
            var recomputed = AuditService.Sha256Hex(canonical);
            if (recomputed != r.RowHash)
            {
                result.Issues.Add(new ChainIssue
                {
                    AuditId = r.Id,
                    Type = "hash_mismatch",
                    StoredRowHash = r.RowHash,
                    RecomputedRowHash = recomputed,
                });
            }

            expectedPrev = r.RowHash;
        }

        result.RowsChecked = rows.Count;
        result.Intact = result.Issues.Count == 0;
        result.HeadHash = expectedPrev ?? AuditService.GenesisHash;
        result.HeadAuditId = rows.Count > 0 ? rows[^1].Id : null;
        return result;
    }

    /// <summary>
    /// Construye el hashable a partir de una fila de DB. Maneja la deserializacion
    /// de evidence_json (string → JsonElement) para que canonicalize produzca
    /// los mismos bytes que con el evidence original.
    /// </summary>
    private static Dictionary<string, object?> BuildHashableFromDb(RawAuditRow r, string createdAtIso, string prevHash)
    {
        object? evidenceCanon = null;
        if (!string.IsNullOrEmpty(r.EvidenceJson))
        {
            try
            {
                using var doc = JsonDocument.Parse(r.EvidenceJson);
                // Clone el RootElement para que sobreviva al dispose del JsonDocument
                evidenceCanon = doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                // Si el evidence_json en DB esta corrupto (no parseable),
                // tratamos como string raw — matchea el catch del parseJsonColumn() del Node
                evidenceCanon = r.EvidenceJson;
            }
        }

        return new Dictionary<string, object?>
        {
            ["schema_version"] = AuditService.SchemaVersion,
            ["user_id"] = r.UserId,
            ["conversation_id"] = r.ConversationId,
            ["action_type"] = r.ActionType,
            ["subject_type"] = r.SubjectType,
            ["subject_id"] = r.SubjectId,
            ["decision"] = r.Decision,
            ["cfr_cited"] = r.CfrCited,
            ["reasoning"] = r.Reasoning,
            ["evidence"] = evidenceCanon,
            ["override_reason"] = r.OverrideReason,
            ["created_at"] = createdAtIso,
            ["prev_hash"] = prevHash,
        };
    }

    private static string TruncateToSecondsIso(DateTime dt)
    {
        // Truncar a precision de segundos UTC (matchea isoSeconds() del Node).
        var utc = dt.Kind == DateTimeKind.Utc ? dt : DateTime.SpecifyKind(dt, DateTimeKind.Utc);
        utc = new DateTime(utc.Year, utc.Month, utc.Day, utc.Hour, utc.Minute, utc.Second, DateTimeKind.Utc);
        return utc.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture);
    }

    private class RawAuditRow
    {
        public long Id { get; set; }
        public long? UserId { get; set; }
        public long? ConversationId { get; set; }
        public string? ActionType { get; set; }
        public string? SubjectType { get; set; }
        public string? SubjectId { get; set; }
        public string? Decision { get; set; }
        public string? CfrCited { get; set; }
        public string? Reasoning { get; set; }
        public string? EvidenceJson { get; set; }
        public string? OverrideReason { get; set; }
        public DateTime CreatedAt { get; set; }
        public string PrevHash { get; set; } = "";
        public string RowHash { get; set; } = "";
    }
}
