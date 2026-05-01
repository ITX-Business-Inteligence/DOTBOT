// Endpoints /api/escalations/* — admin/compliance/manager.
// Equivalente a src/routes/escalations.js Node.

using BotDot.Web.Audit;
using BotDot.Web.Auth;
using BotDot.Web.Data;

namespace BotDot.Web.Routes;

public static class EscalationsEndpoints
{
    private static readonly HashSet<string> ValidStatus = new() { "pending", "assigned", "in_progress", "resolved" };
    private static readonly HashSet<string> ValidUrgency = new() { "low", "medium", "high", "critical" };

    public static void MapEscalationsEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/escalations")
            .AddEndpointFilter(new RequireAuthFilter(Roles.Admin, Roles.Compliance, Roles.Manager));

        grp.MapGet("/badge-count", BadgeCountAsync);
        grp.MapGet("/", ListAsync);
        grp.MapPatch("/{id:long}", UpdateAsync);
    }

    private static async Task<IResult> BadgeCountAsync(IDbAccess db)
    {
        var n = await db.QueryScalarAsync<long?>(
            "SELECT COUNT(*) FROM escalations WHERE status != 'resolved'");
        return Results.Json(new { count = n ?? 0, ts = DateTime.UtcNow.ToString("O") });
    }

    private static async Task<IResult> ListAsync(string? status, string? urgency, int? limit, IDbAccess db)
    {
        var lim = Math.Min(limit ?? 100, 500);
        var clauses = new List<string>();
        var args = new Dictionary<string, object?>();

        if (!string.IsNullOrEmpty(status))
        {
            if (!ValidStatus.Contains(status))
                return Results.Json(new { error = $"status invalido. Validos: {string.Join(", ", ValidStatus)}" }, statusCode: 400);
            clauses.Add("e.status = @Status"); args["Status"] = status;
        }
        if (!string.IsNullOrEmpty(urgency))
        {
            if (!ValidUrgency.Contains(urgency))
                return Results.Json(new { error = $"urgency invalido. Validos: {string.Join(", ", ValidUrgency)}" }, statusCode: 400);
            clauses.Add("e.urgency = @Urgency"); args["Urgency"] = urgency;
        }

        var where = clauses.Count > 0 ? "WHERE " + string.Join(" AND ", clauses) : "";
        args["Lim"] = lim;

        var sql = $@"
            SELECT e.*, u.full_name AS user_name, u.role AS user_role, u.email AS user_email,
                   au.full_name AS assigned_name
            FROM escalations e
            JOIN users u ON u.id = e.user_id
            LEFT JOIN users au ON au.id = e.assigned_to_user_id
            {where}
            ORDER BY
              CASE e.status
                WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1
                WHEN 'assigned' THEN 2 WHEN 'resolved' THEN 3
              END ASC,
              FIELD(e.urgency, 'critical', 'high', 'medium', 'low'),
              e.created_at DESC
            LIMIT @Lim";
        var rows = await db.QueryAsync<dynamic>(sql, args);
        return Results.Json(new { escalations = rows });
    }

    private record UpdateReq(string? Status, long? AssignedToUserId, string? ResolutionNotes);

    private static async Task<IResult> UpdateAsync(long id, UpdateReq req, HttpContext ctx, IDbAccess db, IAuditService audit)
    {
        var actor = ctx.GetUser()!;
        var target = await db.QueryOneAsync<dynamic>("SELECT * FROM escalations WHERE id = @Id", new { Id = id });
        if (target == null) return Results.Json(new { error = "No encontrada" }, statusCode: 404);

        var sets = new List<string>();
        var args = new Dictionary<string, object?>();

        if (req.Status != null)
        {
            if (!ValidStatus.Contains(req.Status))
                return Results.Json(new { error = $"status invalido: {req.Status}" }, statusCode: 400);
            sets.Add("status = @Status"); args["Status"] = req.Status;
            if (req.Status == "resolved")
            {
                sets.Add("resolved_at = CURRENT_TIMESTAMP");
                sets.Add("resolved_by_user_id = @ResolvedBy"); args["ResolvedBy"] = actor.Id;
            }
        }
        if (req.AssignedToUserId.HasValue && req.AssignedToUserId.Value > 0)
        {
            var u = await db.QueryScalarAsync<long?>(
                "SELECT id FROM users WHERE id = @Id AND role IN ('admin','compliance','manager')",
                new { Id = req.AssignedToUserId.Value });
            if (u == null)
                return Results.Json(new { error = "Solo se puede asignar a admin/compliance/manager" }, statusCode: 400);
            sets.Add("assigned_to_user_id = @AssignedTo"); args["AssignedTo"] = req.AssignedToUserId.Value;

            // Auto-promover pending → assigned
            string? targetStatus = ((IDictionary<string, object?>)target).TryGetValue("status", out var st) ? st?.ToString() : null;
            if (targetStatus == "pending")
            {
                sets.Add("status = 'assigned'");
            }
        }
        else if (req.AssignedToUserId.HasValue && req.AssignedToUserId.Value == 0)
        {
            sets.Add("assigned_to_user_id = NULL");
        }
        if (req.ResolutionNotes != null)
        {
            sets.Add("resolution_notes = @Notes"); args["Notes"] = string.IsNullOrEmpty(req.ResolutionNotes) ? null : req.ResolutionNotes;
        }

        if (sets.Count == 0)
            return Results.Json(new { error = "Nada que actualizar" }, statusCode: 400);

        args["Id"] = id;
        await db.ExecuteAsync($"UPDATE escalations SET {string.Join(", ", sets)} WHERE id = @Id", args);

        await audit.AppendAsync(new AuditEntry
        {
            UserId = actor.Id,
            ActionType = "escalation_update",
            SubjectType = "escalation",
            SubjectId = id.ToString(),
            Decision = "informational",
            Reasoning = $"{actor.Email} actualizo escalacion #{id}",
            Evidence = new Dictionary<string, object?>
            {
                ["changes"] = req,
            },
        });

        var updated = await db.QueryOneAsync<dynamic>("SELECT * FROM escalations WHERE id = @Id", new { Id = id });
        return Results.Json(new { escalation = updated });
    }
}
