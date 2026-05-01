// Implementacion real del audit chain — reemplaza StubAuditService.
// Port byte-exact de appendAudit() en src/db/audit-chain.js del Node.
//
// Flujo:
//   1. BEGIN TRANSACTION
//   2. SELECT GET_LOCK('botdot_audit_chain', 10) — serializa con otras inserciones
//   3. SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1  → prevHash (o GENESIS si vacia)
//   4. Construir hashable con timestamp UTC truncado a segundos
//   5. canonical = Canonicalize.Serialize(hashable)
//   6. rowHash = SHA-256(canonical, UTF-8)
//   7. INSERT audit_log con prev_hash + row_hash + evidence_json (JSON.stringify de evidence)
//   8. COMMIT  (RELEASE_LOCK al cerrar la conexion)

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BotDot.Web.Data;
using Dapper;

namespace BotDot.Web.Audit;

public class AuditService : IAuditService
{
    /// <summary>Hash todo-ceros para la primera fila de la cadena.</summary>
    public const string GenesisHash = "0000000000000000000000000000000000000000000000000000000000000000";

    /// <summary>Nombre del lock MySQL para serializar inserciones concurrentes.</summary>
    private const string ChainLockName = "botdot_audit_chain";
    private const int ChainLockTimeoutSec = 10;

    /// <summary>
    /// Schema version del hashable. Si alguna vez cambia la estructura del
    /// hashable (campos agregados/quitados), bumpear este numero — es lo que
    /// preserva la verificabilidad de filas viejas.
    /// </summary>
    public const int SchemaVersion = 1;

    private readonly IDbAccess _db;
    private readonly ILogger<AuditService> _log;

    public AuditService(IDbAccess db, ILogger<AuditService> log)
    {
        _db = db;
        _log = log;
    }

    public async Task<AuditAppendResult> AppendAsync(AuditEntry entry, CancellationToken ct = default)
    {
        return await _db.TransactionAsync(async (conn, tx) =>
        {
            // 1. Adquirir lock — serializa contra otros inserts concurrentes
            //    (mismo nombre de lock que usa el Node).
            var got = await conn.ExecuteScalarAsync<int?>(
                "SELECT GET_LOCK(@name, @timeout)",
                new { name = ChainLockName, timeout = ChainLockTimeoutSec },
                tx);
            if (got != 1)
                throw new InvalidOperationException("No se pudo adquirir lock de la cadena de audit (timeout)");

            try
            {
                // 2. Leer head actual
                var prevHash = await conn.ExecuteScalarAsync<string?>(
                    "SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1",
                    transaction: tx) ?? GenesisHash;

                // 3. Timestamp UTC truncado a segundos (matchea isoSeconds() del Node).
                //    Truncar al inicio del segundo para que la conversion sea estable
                //    aunque MySQL guarde DATETIME(6) o DATETIME plain.
                var nowUtc = DateTime.UtcNow;
                nowUtc = new DateTime(nowUtc.Year, nowUtc.Month, nowUtc.Day,
                    nowUtc.Hour, nowUtc.Minute, nowUtc.Second, DateTimeKind.Utc);
                var createdAtIso = nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture);
                var createdAtForDb = nowUtc.ToString("yyyy-MM-dd HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture);

                // 4. evidence: lo guardamos como JSON string en DB; pero el hash
                //    se calcula sobre el OBJETO original (que canonicalize).
                //    Esto matchea el roundtrip Node: serializamos con
                //    JSON.stringify para DB, pero pasamos el objeto al hashable.
                var evidenceForDb = entry.Evidence == null
                    ? null
                    : JsonSerializer.Serialize(entry.Evidence, JsonSerializerOpts.RawJs);

                // 5. Construir hashable y calcular row_hash.
                //    Object.keys(...).sort() canonicaliza el orden, asi que
                //    no importa el orden en que metamos los pares aca.
                var hashable = BuildHashable(entry, createdAtIso, prevHash);
                var canonical = Canonicalize.Serialize(hashable);
                var rowHash = Sha256Hex(canonical);

                // 6. INSERT
                var sql = @"INSERT INTO audit_log
                              (user_id, conversation_id, action_type, subject_type, subject_id,
                               decision, cfr_cited, reasoning, evidence_json, override_reason,
                               created_at, prev_hash, row_hash)
                            VALUES
                              (@UserId, @ConversationId, @ActionType, @SubjectType, @SubjectId,
                               @Decision, @CfrCited, @Reasoning, @EvidenceJson, @OverrideReason,
                               @CreatedAt, @PrevHash, @RowHash)";
                await conn.ExecuteAsync(sql, new
                {
                    UserId = entry.UserId,
                    ConversationId = entry.ConversationId,
                    ActionType = entry.ActionType,
                    SubjectType = entry.SubjectType,
                    SubjectId = entry.SubjectId,
                    Decision = entry.Decision,
                    CfrCited = entry.CfrCited,
                    Reasoning = entry.Reasoning,
                    EvidenceJson = evidenceForDb,
                    OverrideReason = entry.OverrideReason,
                    CreatedAt = createdAtForDb,
                    PrevHash = prevHash,
                    RowHash = rowHash,
                }, tx);

                var auditId = await conn.ExecuteScalarAsync<long>("SELECT LAST_INSERT_ID()", transaction: tx);

                return new AuditAppendResult
                {
                    AuditId = auditId,
                    RowHash = rowHash,
                    PrevHash = prevHash,
                };
            }
            finally
            {
                // RELEASE_LOCK — best effort, no bloqueamos el commit por esto.
                try
                {
                    await conn.ExecuteScalarAsync<int?>(
                        "SELECT RELEASE_LOCK(@name)",
                        new { name = ChainLockName },
                        tx);
                }
                catch (Exception relErr)
                {
                    _log.LogWarning(relErr, "RELEASE_LOCK fallo (no bloqueante)");
                }
            }
        });
    }

    /// <summary>
    /// Construye el dictionary que se canonicaliza y hashea. Esta funcion
    /// debe matchear EXACTAMENTE el buildHashable() del Node — cualquier
    /// diferencia rompe la verificabilidad de filas existentes.
    ///
    /// Las keys se ordenan despues por canonicalize() — el orden aca no importa.
    /// </summary>
    public static Dictionary<string, object?> BuildHashable(AuditEntry entry, string createdAtIso, string prevHash)
    {
        // evidence: si viene como objeto C#, lo convertimos a JsonElement
        // (round-trip via JSON.serialize) para que canonicalize lo trate
        // como dict generico — matchea el comportamiento de mysql2 en Node
        // que devuelve la columna JSON ya parseada como objeto.
        object? evidenceCanon = entry.Evidence switch
        {
            null => null,
            JsonElement je => (object)je,
            _ => JsonSerializer.SerializeToElement(entry.Evidence, JsonSerializerOpts.RawJs)
        };

        return new Dictionary<string, object?>
        {
            ["schema_version"] = SchemaVersion,
            ["user_id"] = entry.UserId,
            ["conversation_id"] = entry.ConversationId,
            ["action_type"] = entry.ActionType,
            ["subject_type"] = entry.SubjectType,
            ["subject_id"] = entry.SubjectId,
            ["decision"] = entry.Decision,
            ["cfr_cited"] = entry.CfrCited,
            ["reasoning"] = entry.Reasoning,
            ["evidence"] = evidenceCanon,
            ["override_reason"] = entry.OverrideReason,
            ["created_at"] = createdAtIso,
            ["prev_hash"] = prevHash,
        };
    }

    public static string Sha256Hex(string canonical)
    {
        var bytes = Encoding.UTF8.GetBytes(canonical);
        var hash = SHA256.HashData(bytes);
        var sb = new StringBuilder(hash.Length * 2);
        foreach (var b in hash) sb.Append(b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        return sb.ToString();
    }
}

/// <summary>
/// Opciones de System.Text.Json sin naming policy — usamos los nombres de
/// propiedad tal cual. Para serializar evidence al formato Raw que matchea
/// JSON.stringify del Node.
/// </summary>
internal static class JsonSerializerOpts
{
    public static readonly JsonSerializerOptions RawJs = new()
    {
        // sin naming policy — evidence ya viene con keys snake_case desde quien lo construye
        WriteIndented = false,
        // Node JSON.stringify NO escapa unicode chars >= U+0020 a \uXXXX.
        // Por default System.Text.Json escapa demasiado (HTML, comillas tipograficas, etc).
        // UnsafeRelaxedJsonEscaping desactiva esos escapes extra.
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}
