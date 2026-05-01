// Endpoints /api/dashboard/* — equivalente a src/routes/dashboard.js Node.

using BotDot.Web.Auth;
using BotDot.Web.Data;

namespace BotDot.Web.Routes;

public static class DashboardEndpoints
{
    private static readonly RequireAuthFilter MgmtFilter = new(Roles.Admin, Roles.Compliance, Roles.Manager);

    public static void MapDashboardEndpoints(this IEndpointRouteBuilder app)
    {
        var auth = app.MapGroup("/api/dashboard").AddEndpointFilter(new RequireAuthFilter());

        // BASICs/KPIs/audit — solo management roles
        auth.MapGet("/basics", BasicsAsync).AddEndpointFilter(MgmtFilter);
        auth.MapGet("/kpis", KpisAsync).AddEndpointFilter(MgmtFilter);
        auth.MapGet("/audit", AuditEntriesAsync).AddEndpointFilter(MgmtFilter);

        // drivers-at-risk — cualquier rol autenticado (dispatcher tambien)
        auth.MapGet("/drivers-at-risk", DriversAtRiskAsync);
        auth.MapGet("/drivers-near-limit", DriversNearLimitAsync);
    }

    private static async Task<IResult> BasicsAsync(IDbAccess db)
    {
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT basic_name, score_pct, threshold_pct, alert, months_in_alert, violations_count
              FROM sms_snapshots
              WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_snapshots)
              ORDER BY score_pct DESC");
        return Results.Json(new { basics = rows });
    }

    private static async Task<IResult> KpisAsync(IDbAccess db)
    {
        var basicAlert = await db.QueryScalarAsync<long?>(
            @"SELECT COUNT(*) FROM sms_snapshots
              WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_snapshots) AND alert = 1");
        var crashes24m = await db.QueryScalarAsync<long?>(
            "SELECT COUNT(*) FROM sms_crashes WHERE crash_date >= DATE_SUB(CURDATE(), INTERVAL 24 MONTH)");
        var dataqs = await db.QueryScalarAsync<long?>(
            @"SELECT COUNT(*) FROM sms_crashes
              WHERE dataqs_disputed = 0 AND (not_preventable IS NULL OR not_preventable = 0)");
        var overrides = await db.QueryScalarAsync<long?>(
            @"SELECT COUNT(*) FROM audit_log
              WHERE decision = 'override' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)");

        return Results.Json(new
        {
            basics_in_alert = basicAlert,
            crashes_24m = crashes24m,
            dataqs_candidates = dataqs,
            overrides_30d = overrides,
        });
    }

    private static async Task<IResult> AuditEntriesAsync(int? limit, IDbAccess db)
    {
        var lim = Math.Min(limit ?? 50, 200);
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT a.id, a.action_type, a.subject_type, a.subject_id, a.decision, a.cfr_cited,
                     a.reasoning, a.created_at, u.full_name AS user_name, u.role AS user_role
              FROM audit_log a JOIN users u ON u.id = a.user_id
              ORDER BY a.id DESC LIMIT @Lim",
            new { Lim = lim });
        return Results.Json(new { entries = rows });
    }

    private static async Task<IResult> DriversAtRiskAsync(int? limit, int? horizon_days, IDbAccess db)
    {
        var lim = Math.Min(limit ?? 10, 100);
        var horizon = Math.Min(horizon_days ?? 60, 365);

        var rows = await db.QueryAsync<DriverAtRiskRow>(
            @"SELECT
                id AS Id, samsara_id AS SamsaraId, full_name AS FullName,
                cdl_number AS CdlNumber, cdl_state AS CdlState, cdl_expiration AS CdlExpiration,
                medical_card_expiration AS MedicalCardExpiration,
                DATEDIFF(cdl_expiration, CURDATE())          AS CdlDays,
                DATEDIFF(medical_card_expiration, CURDATE()) AS MedicalDays
              FROM drivers
              WHERE active = 1
                AND (
                  (cdl_expiration IS NOT NULL AND cdl_expiration <= DATE_ADD(CURDATE(), INTERVAL @H DAY))
                  OR
                  (medical_card_expiration IS NOT NULL AND medical_card_expiration <= DATE_ADD(CURDATE(), INTERVAL @H DAY))
                )
              ORDER BY LEAST(
                IFNULL(DATEDIFF(cdl_expiration, CURDATE()), 9999),
                IFNULL(DATEDIFF(medical_card_expiration, CURDATE()), 9999)
              ) ASC
              LIMIT @LimPlus1",
            new { H = horizon, LimPlus1 = lim + 1 });

        var hasMore = rows.Count > lim;
        var taken = rows.Take(lim).Select(r =>
        {
            var cdlD = r.CdlDays ?? int.MaxValue;
            var medD = r.MedicalDays ?? int.MaxValue;
            var soonestKind = cdlD <= medD ? "cdl" : "medical";
            var soonestDays = Math.Min(cdlD, medD);
            return new
            {
                id = r.Id,
                samsara_id = r.SamsaraId,
                full_name = r.FullName,
                cdl_number = r.CdlNumber,
                cdl_expiration = r.CdlExpiration,
                cdl_days = r.CdlDays,
                medical_card_expiration = r.MedicalCardExpiration,
                medical_days = r.MedicalDays,
                soonest_kind = soonestKind,
                soonest_days = soonestDays == int.MaxValue ? (int?)null : soonestDays,
            };
        }).ToList();

        var total = await db.QueryScalarAsync<long?>(
            @"SELECT COUNT(*) FROM drivers
              WHERE active = 1
                AND (
                  (cdl_expiration IS NOT NULL AND cdl_expiration <= DATE_ADD(CURDATE(), INTERVAL @H DAY))
                  OR
                  (medical_card_expiration IS NOT NULL AND medical_card_expiration <= DATE_ADD(CURDATE(), INTERVAL @H DAY))
                )",
            new { H = horizon });

        return Results.Json(new
        {
            drivers = taken,
            total_at_risk = total ?? 0,
            shown = taken.Count,
            has_more = hasMore,
            horizon_days = horizon,
        });
    }

    private static IResult DriversNearLimitAsync()
    {
        // MVP: pendiente integracion Samsara live. Devolvemos shape vacia.
        return Results.Json(new { drivers = Array.Empty<object>(), note = "Pendiente integracion Samsara live" });
    }

    private class DriverAtRiskRow
    {
        public long Id { get; set; }
        public string? SamsaraId { get; set; }
        public string? FullName { get; set; }
        public string? CdlNumber { get; set; }
        public string? CdlState { get; set; }
        public DateTime? CdlExpiration { get; set; }
        public DateTime? MedicalCardExpiration { get; set; }
        public int? CdlDays { get; set; }
        public int? MedicalDays { get; set; }
    }
}
