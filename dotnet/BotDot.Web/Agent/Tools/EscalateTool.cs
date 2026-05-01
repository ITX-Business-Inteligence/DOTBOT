// escalate_to_compliance — handoff a humano cuando el bot no puede resolver.
//
// Flujo (matchea src/agent/tools/escalate.js del Node):
//   1. INSERT escalations status=pending
//   2. AppendAudit(escalation_created) — queda en hash chain
//   3. Email async a compliance team (alias config o todos los users con role=compliance)
//   4. Devolver al agente { escalated, escalation_id, message_to_user }
//      con la frase fija que el bot debe cerrar al usuario.

using System.Text.Json;
using BotDot.Web.Audit;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using BotDot.Web.Email;
using Dapper;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Agent.Tools;

public class EscalateToComplianceTool : ITool
{
    public const string RedirectPhrase =
        "Esta consulta requiere revision humana. Te conecto con compliance — " +
        "un officer va a revisar tu caso y te contactara.";

    private readonly IDbAccess _db;
    private readonly IAuditService _audit;
    private readonly IEmailService _email;
    private readonly IOptions<BotDotOptions> _opts;
    private readonly ILogger<EscalateToComplianceTool> _log;

    public EscalateToComplianceTool(
        IDbAccess db, IAuditService audit, IEmailService email,
        IOptions<BotDotOptions> opts, ILogger<EscalateToComplianceTool> log)
    {
        _db = db;
        _audit = audit;
        _email = email;
        _opts = opts;
        _log = log;
    }

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "escalate_to_compliance",
        "Crea una escalacion al equipo de compliance cuando NO podes dar una recomendacion solida sobre un caso operacional (asignacion, fitness, decision regulatoria) por falta de data o ambiguedad. NO usar para preguntas off-topic, evasion, o saludos — esas tienen sus propias tools (log_off_topic / log_refused_request). NO usar para preguntas puramente informativas que simplemente no tenes en tu base — esas respondelas con 'no lo tengo, verifica en ecfr.gov'. USAR cuando el usuario esta por tomar una decision con consecuencias y vos no tenes fundamento para guiarla.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["summary"] = new { type = "string", description = "Resumen breve del caso (que pregunta el usuario, sobre quien, en que contexto). 1-2 oraciones." },
                ["category"] = new
                {
                    type = "string",
                    @enum = new[] { "missing_data", "ambiguous_compliance", "user_requested", "complex_decision", "potential_violation", "other" },
                },
                ["urgency"] = new
                {
                    type = "string",
                    @enum = new[] { "low", "medium", "high", "critical" },
                    description = "critical: violacion inminente o decision de minutos. high: decision pendiente del dia con riesgo regulatorio. medium: pregunta operacional con datos parciales. low: duda menor sin urgencia.",
                },
                ["what_was_missing"] = new { type = "string", description = "Que data o validacion te falto para responder vos solo." },
            },
            required = new[] { "summary", "category", "urgency" },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var summary = ToolInputs.GetString(input, "summary") ?? "(sin resumen)";
        var category = ToolInputs.GetString(input, "category") ?? "other";
        var urgency = ToolInputs.GetString(input, "urgency") ?? "low";
        var whatMissing = ToolInputs.GetString(input, "what_was_missing");

        // 1. INSERT escalations (ExecuteInsertAsync mantiene la conexion abierta
        //    entre INSERT y LAST_INSERT_ID — sin eso devuelve 0 con auto-open de Dapper).
        var escalationId = await _db.ExecuteInsertAsync(
            @"INSERT INTO escalations
                (user_id, conversation_id, trigger_message, bot_reasoning, category, urgency, status)
              VALUES (@UserId, @ConvId, @Trigger, @Reasoning, @Cat, @Urg, 'pending')",
            new
            {
                UserId = ctx.User.Id,
                ConvId = ctx.ConversationId,
                Trigger = summary,
                Reasoning = whatMissing,
                Cat = category,
                Urg = urgency,
            });

        // 2. Audit chain
        try
        {
            await _audit.AppendAsync(new AuditEntry
            {
                UserId = ctx.User.Id,
                ConversationId = ctx.ConversationId,
                ActionType = "escalation_created",
                SubjectType = "escalation",
                SubjectId = escalationId.ToString(),
                Decision = "informational",
                Reasoning = $"Bot escalo a compliance: [{category}/{urgency}] {summary}",
                Evidence = new Dictionary<string, object?>
                {
                    ["summary"] = summary,
                    ["category"] = category,
                    ["urgency"] = urgency,
                    ["what_was_missing"] = whatMissing,
                },
            }, ct);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "audit chain falla en escalation_created (no bloqueante)");
        }

        // 3. Email async (no bloquea)
        _ = SendEscalationEmailAsync(escalationId, summary, category, urgency, whatMissing, ctx);

        return new
        {
            escalated = true,
            escalation_id = escalationId,
            message_to_user = RedirectPhrase,
        };
    }

    private async Task SendEscalationEmailAsync(long escalationId, string summary, string category, string urgency, string? whatMissing, ToolContext ctx)
    {
        try
        {
            var emailOpts = _opts.Value.Email;
            List<string> recipients;
            if (!string.IsNullOrWhiteSpace(emailOpts.EscalationsTo))
            {
                recipients = emailOpts.EscalationsTo.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
            }
            else
            {
                var rows = await _db.QueryAsync<string>(
                    "SELECT email FROM users WHERE role = 'compliance' AND active = 1");
                recipients = rows.ToList();
            }

            if (recipients.Count == 0)
            {
                await _db.ExecuteAsync(
                    "UPDATE escalations SET email_error = @Err WHERE id = @Id",
                    new { Err = "No hay usuarios con rol compliance activos para notificar", Id = escalationId });
                return;
            }

            var emoji = urgency switch
            {
                "critical" => "[CRITICAL]",
                "high" => "[HIGH]",
                "medium" => "[MEDIUM]",
                _ => "[LOW]",
            };
            var subject = $"{emoji} BOTDOT escalacion {urgency.ToUpperInvariant()} — {category} — #{escalationId}";
            var text =
$@"Una nueva escalacion fue creada por BOTDOT.

Usuario: {ctx.User.Name} ({ctx.User.Role}) <{ctx.User.Email}>
Urgencia: {urgency}
Categoria: {category}
Escalacion ID: {escalationId}

Resumen del caso:
{summary}

Lo que le falto al bot:
{whatMissing ?? "(sin detalle)"}

Para revisar y resolver, abre el dashboard:
{_opts.Value.PublicUrl}/escalations.html

— BOTDOT (no respondas a este email, abre el dashboard)
";

            var result = await _email.SendAsync(new EmailMessage
            {
                To = recipients,
                Subject = subject,
                Text = text,
            });

            await _db.ExecuteAsync(
                @"UPDATE escalations
                  SET email_sent_at = @SentAt, email_recipients = @Recipients, email_error = @Err
                  WHERE id = @Id",
                new
                {
                    SentAt = result.Sent ? (DateTime?)DateTime.UtcNow : null,
                    Recipients = string.Join(",", recipients),
                    Err = result.Sent ? null : (result.Error ?? "unknown"),
                    Id = escalationId,
                });
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "sendEscalationEmail falla escalation_id={Id}", escalationId);
        }
    }
}
