// Endpoints /api/notifications/* — admin/compliance/manager.
// Equivalente a src/routes/notifications.js Node.

using BotDot.Web.Audit;
using BotDot.Web.Auth;
using BotDot.Web.Data;
using BotDot.Web.Jobs;

namespace BotDot.Web.Routes;

public static class NotificationsEndpoints
{
    private static readonly HashSet<string> ValidStatus = new() { "active", "dismissed", "resolved" };
    private static readonly HashSet<string> ValidUrgency = new() { "low", "medium", "high", "critical" };
    private static readonly HashSet<string> ValidKind = new() { "cdl_expiring", "medical_expiring", "cdl_expired", "medical_expired" };

    public static void MapNotificationsEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/notifications")
            .AddEndpointFilter(new RequireAuthFilter(Roles.Admin, Roles.Compliance, Roles.Manager));

        grp.MapGet("/badge-count", BadgeCountAsync);
        grp.MapGet("/", ListAsync);
        grp.MapPost("/{id:long}/dismiss", DismissAsync);
        grp.MapPost("/run-job", RunJobAsync).AddEndpointFilter(new RequireAuthFilter(Roles.Admin));
    }

    private static async Task<IResult> BadgeCountAsync(IDbAccess db)
    {
        var n = await db.QueryScalarAsync<long?>(
            "SELECT COUNT(*) FROM notifications WHERE status = 'active'");
        return Results.Json(new { count = n ?? 0, ts = DateTime.UtcNow.ToString("O") });
    }

    private static async Task<IResult> ListAsync(string? status, string? urgency, string? kind, int? limit, IDbAccess db)
    {
        if (!string.IsNullOrEmpty(status) && !ValidStatus.Contains(status))
            return Results.Json(new { error = $"status invalido. Validos: {string.Join(", ", ValidStatus)}" }, statusCode: 400);
        if (!string.IsNullOrEmpty(urgency) && !ValidUrgency.Contains(urgency))
            return Results.Json(new { error = $"urgency invalido. Validos: {string.Join(", ", ValidUrgency)}" }, statusCode: 400);
        if (!string.IsNullOrEmpty(kind) && !ValidKind.Contains(kind))
            return Results.Json(new { error = $"kind invalido. Validos: {string.Join(", ", ValidKind)}" }, statusCode: 400);

        var lim = Math.Min(limit ?? 200, 1000);
        var clauses = new List<string>();
        var args = new Dictionary<string, object?>();
        if (!string.IsNullOrEmpty(status)) { clauses.Add("n.status = @S"); args["S"] = status; }
        if (!string.IsNullOrEmpty(urgency)) { clauses.Add("n.urgency = @U"); args["U"] = urgency; }
        if (!string.IsNullOrEmpty(kind)) { clauses.Add("n.kind = @K"); args["K"] = kind; }
        var where = clauses.Count > 0 ? "WHERE " + string.Join(" AND ", clauses) : "";
        args["Lim"] = lim;

        var sql = $@"
            SELECT n.*,
                   d.full_name AS driver_name,
                   d.cdl_number, d.cdl_state, d.cdl_expiration,
                   d.medical_card_expiration, d.location, d.company,
                   dis.full_name AS dismissed_by_name
            FROM notifications n
            LEFT JOIN drivers d ON d.id = n.subject_id AND n.subject_type = 'driver'
            LEFT JOIN users dis ON dis.id = n.dismissed_by_user_id
            {where}
            ORDER BY
              CASE n.status
                WHEN 'active' THEN 0 WHEN 'dismissed' THEN 1 WHEN 'resolved' THEN 2
              END ASC,
              FIELD(n.urgency, 'critical', 'high', 'medium', 'low'),
              n.threshold ASC,
              n.created_at DESC
            LIMIT @Lim";
        var rows = await db.QueryAsync<dynamic>(sql, args);
        return Results.Json(new { notifications = rows });
    }

    private record DismissReq(string? Note);

    private static async Task<IResult> DismissAsync(long id, DismissReq? req, HttpContext ctx, IDbAccess db, IAuditService audit)
    {
        var actor = ctx.GetUser()!;
        var target = await db.QueryOneAsync<dynamic>("SELECT * FROM notifications WHERE id = @Id", new { Id = id });
        if (target == null) return Results.Json(new { error = "Notificacion no encontrada" }, statusCode: 404);

        string? targetStatus = ((IDictionary<string, object?>)target).TryGetValue("status", out var st) ? st?.ToString() : null;
        if (targetStatus != "active")
            return Results.Json(new { error = "Notificacion ya no esta activa" }, statusCode: 400);

        await db.ExecuteAsync(
            @"UPDATE notifications
              SET status = 'dismissed',
                  dismissed_at = CURRENT_TIMESTAMP,
                  dismissed_by_user_id = @U,
                  dismissal_note = @Note
              WHERE id = @Id",
            new { U = actor.Id, Note = req?.Note, Id = id });

        await audit.AppendAsync(new AuditEntry
        {
            UserId = actor.Id,
            ActionType = "notification_dismissed",
            SubjectType = "notification",
            SubjectId = id.ToString(),
            Decision = "informational",
            Reasoning = $"{actor.Email} dismissed notification #{id}",
            Evidence = new Dictionary<string, object?>
            {
                ["note"] = req?.Note,
            },
        });

        return Results.Json(new { dismissed = true });
    }

    private static async Task<IResult> RunJobAsync(ExpirationAlertsService svc)
    {
        try
        {
            var result = await svc.RunAsync();
            return Results.Json(new
            {
                scanned = result.Scanned,
                inserted = result.Inserted,
                elapsed_ms = result.ElapsedMs,
            });
        }
        catch (Exception ex)
        {
            return Results.Json(new { error = ex.Message }, statusCode: 500);
        }
    }
}
