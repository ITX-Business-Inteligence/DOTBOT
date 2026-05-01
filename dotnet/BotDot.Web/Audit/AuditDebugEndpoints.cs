// Endpoints debug — SOLO se mapean en Development.
// Existen para verificacion cross-stack del audit chain y agent
// (scripts/verify-cross-stack-*.js del Node comparan byte-a-byte
// el output de ambos stacks).
//
// NUNCA mapear en Production: exponen primitivas internas sin auth, lo
// cual no es vector real (no hay PII), pero filosoficamente no debe correr
// fuera de dev.

using System.Text.Json;
using BotDot.Web.Agent;
using BotDot.Web.Agent.Tools;

namespace BotDot.Web.Audit;

public static class AuditDebugEndpoints
{
    public static void MapAuditDebugEndpoints(this IEndpointRouteBuilder app)
    {
        // GET /api/_debug/agent/tool-defs
        // Devuelve la lista de TOOL_DEFINITIONS tal como se mandan a Anthropic.
        // El script Node compara byte-a-byte con sus propias TOOL_DEFINITIONS.
        app.MapGet("/api/_debug/agent/tool-defs", (ToolRegistry tools) =>
        {
            var defs = tools.AllDefinitions
                .OrderBy(d => d.Name, StringComparer.Ordinal)
                .Select(d => new
                {
                    name = d.Name,
                    description = d.Description,
                    input_schema = d.InputSchema,
                })
                .ToList();
            return Results.Json(new { tools = defs });
        });

        // POST /api/_debug/audit/canonicalize
        // Body: { "mode": "value" | "audit_row", "value": <any JSON> }
        //   mode=value      → canonicaliza directo el JSON pasado
        //   mode=audit_row  → BuildHashable(value) + canonicalize del hashable
        // Response: { "canonical": "...", "hash": "..." }
        app.MapPost("/api/_debug/audit/canonicalize", (DebugCanonicalizeRequest req) =>
        {
            string canonical;
            switch (req.Mode)
            {
                case "value":
                    canonical = Canonicalize.SerializeJsonElement(req.Value);
                    break;
                case "audit_row":
                    var entry = ParseAuditEntry(req.Value);
                    var createdAtIso = req.Value.TryGetProperty("created_at_iso", out var ca)
                        ? ca.GetString()!
                        : throw new ArgumentException("audit_row requiere campo created_at_iso");
                    var prevHash = req.Value.TryGetProperty("prev_hash", out var ph)
                        ? ph.GetString()!
                        : throw new ArgumentException("audit_row requiere campo prev_hash");
                    var hashable = AuditService.BuildHashable(entry, createdAtIso, prevHash);
                    canonical = Canonicalize.Serialize(hashable);
                    break;
                default:
                    return Results.BadRequest(new { error = $"mode invalido: {req.Mode}. Usa 'value' o 'audit_row'." });
            }
            var hash = AuditService.Sha256Hex(canonical);
            return Results.Json(new { canonical, hash });
        });
    }

    private static AuditEntry ParseAuditEntry(JsonElement el)
    {
        // Campos del audit_log que entran en BuildHashable. Soporta null
        // (campo ausente o explicitamente null) — debe matchear el comportamiento
        // de Node donde row.x ?? null produce null para faltantes.
        long? userId = el.TryGetProperty("user_id", out var u) && u.ValueKind != JsonValueKind.Null
            ? u.GetInt64() : null;
        long? convId = el.TryGetProperty("conversation_id", out var c) && c.ValueKind != JsonValueKind.Null
            ? c.GetInt64() : null;
        string? actionType = el.TryGetProperty("action_type", out var at) && at.ValueKind != JsonValueKind.Null
            ? at.GetString() : null;
        string? subjectType = el.TryGetProperty("subject_type", out var st) && st.ValueKind != JsonValueKind.Null
            ? st.GetString() : null;
        string? subjectId = el.TryGetProperty("subject_id", out var si) && si.ValueKind != JsonValueKind.Null
            ? si.GetString() : null;
        string? decision = el.TryGetProperty("decision", out var dec) && dec.ValueKind != JsonValueKind.Null
            ? dec.GetString() : null;
        string? cfrCited = el.TryGetProperty("cfr_cited", out var cfr) && cfr.ValueKind != JsonValueKind.Null
            ? cfr.GetString() : null;
        string? reasoning = el.TryGetProperty("reasoning", out var r) && r.ValueKind != JsonValueKind.Null
            ? r.GetString() : null;
        string? overrideReason = el.TryGetProperty("override_reason", out var or) && or.ValueKind != JsonValueKind.Null
            ? or.GetString() : null;

        // Evidence: lo dejamos como JsonElement Cloned (para que sobreviva
        // al final del request) — BuildHashable lo trata como JsonElement.
        object? evidence = null;
        if (el.TryGetProperty("evidence", out var ev) && ev.ValueKind != JsonValueKind.Null)
            evidence = ev.Clone();

        return new AuditEntry
        {
            UserId = userId,
            ConversationId = convId,
            ActionType = actionType,
            SubjectType = subjectType,
            SubjectId = subjectId,
            Decision = decision,
            CfrCited = cfrCited,
            Reasoning = reasoning,
            Evidence = evidence,
            OverrideReason = overrideReason,
        };
    }
}

public class DebugCanonicalizeRequest
{
    public string Mode { get; set; } = "value";
    public JsonElement Value { get; set; }
}
