// Interface del audit chain. La implementacion REAL viene en Fase 3
// (port byte-exact del src/db/audit-chain.js). Por ahora tenemos un stub
// que loggea pero no escribe a la cadena — permite Fase 2 (auth + lockout
// audit calls) sin bloquear hasta Fase 3.

namespace BotDot.Web.Audit;

public class AuditEntry
{
    public long? UserId { get; set; }
    public long? ConversationId { get; set; }
    public string ActionType { get; set; } = "";
    public string? SubjectType { get; set; }
    public string? SubjectId { get; set; }
    public string? Decision { get; set; }
    public string? CfrCited { get; set; }
    public string? Reasoning { get; set; }
    public object? Evidence { get; set; }
    public string? OverrideReason { get; set; }
}

public class AuditAppendResult
{
    public long AuditId { get; set; }
    public string RowHash { get; set; } = "";
    public string PrevHash { get; set; } = "";
}

public interface IAuditService
{
    /// <summary>
    /// Inserta una fila en audit_log calculando prev_hash y row_hash.
    /// Usa GET_LOCK MySQL para serializar inserciones concurrentes.
    /// </summary>
    Task<AuditAppendResult> AppendAsync(AuditEntry entry, CancellationToken ct = default);
}

/// <summary>
/// STUB temporal — solo loggea. La implementacion real viene en Fase 3
/// con el port byte-exact del hash chain.
/// </summary>
public class StubAuditService : IAuditService
{
    private readonly ILogger<StubAuditService> _log;
    public StubAuditService(ILogger<StubAuditService> log) => _log = log;

    public Task<AuditAppendResult> AppendAsync(AuditEntry entry, CancellationToken ct = default)
    {
        _log.LogWarning(
            "[AUDIT STUB] action={ActionType} user={UserId} subject={SubjectType}/{SubjectId} decision={Decision} reasoning={Reasoning}",
            entry.ActionType, entry.UserId, entry.SubjectType, entry.SubjectId, entry.Decision, entry.Reasoning);
        return Task.FromResult(new AuditAppendResult
        {
            AuditId = 0,
            RowHash = "STUB",
            PrevHash = "STUB"
        });
    }
}
