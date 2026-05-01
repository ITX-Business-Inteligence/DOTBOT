// Endpoints de admin sync (Samsara) + CFR auto-update.
// Equivalente a las secciones de sync y cfr en src/routes/admin.js Node.

using BotDot.Web.Auth;
using BotDot.Web.Data;

namespace BotDot.Web.Routes;

public static class AdminSyncCfrEndpoints
{
    public static void MapAdminSyncCfrEndpoints(this IEndpointRouteBuilder app)
    {
        var auth = app.MapGroup("/api/admin").AddEndpointFilter(new RequireAuthFilter());

        // Sync — admin only
        var syncAdmin = auth.MapGroup("/").AddEndpointFilter(new RequireAuthFilter(Roles.Admin));
        syncAdmin.MapGet("/sync/status", SyncStatusAsync);
        syncAdmin.MapPost("/sync/run/{resource}", SyncRunAsync);

        // CFR — read endpoints para mgmt; force-run admin only
        var cfrMgmt = auth.MapGroup("/").AddEndpointFilter(new RequireAuthFilter(Roles.Admin, Roles.Compliance, Roles.Manager));
        cfrMgmt.MapGet("/cfr/runs", CfrRunsAsync);
        cfrMgmt.MapGet("/cfr/versions/{section}", CfrVersionsAsync);

        var cfrAdmin = auth.MapGroup("/").AddEndpointFilter(new RequireAuthFilter(Roles.Admin));
        cfrAdmin.MapPost("/cfr/run", CfrRunAdHocAsync);
    }

    // ─── Sync ────────────────────────────────────────────────────

    private static async Task<IResult> SyncStatusAsync(IDbAccess db)
    {
        var runs = await db.QueryAsync<dynamic>(
            @"SELECT id, resource, started_at, finished_at, status, records_synced,
                     duration_ms, source, LEFT(error_message, 200) AS error_message
              FROM sync_runs
              ORDER BY id DESC LIMIT 30");
        var lastSuccess = await db.QueryAsync<dynamic>(
            @"SELECT resource, MAX(finished_at) AS last_success_at
              FROM sync_runs WHERE status = 'success' GROUP BY resource");
        return Results.Json(new { runs, last_success = lastSuccess });
    }

    private static IResult SyncRunAsync(string resource)
    {
        // Stub Fase 5 — implementacion real va en Fase 7 (jobs background).
        // El Node manda a sync/drivers/vehicles/hos. Por ahora respondemos
        // 503 con mensaje claro.
        var validResources = new[] { "drivers", "vehicles", "hos_clocks" };
        if (!validResources.Contains(resource))
            return Results.Json(new { error = $"Resource invalido. Usa: {string.Join(", ", validResources)}" }, statusCode: 400);
        return Results.Json(new
        {
            error = "Sync ad-hoc pendiente Fase 7 (jobs background). Por ahora la cadena Node sigue activa para sync."
        }, statusCode: 503);
    }

    // ─── CFR ─────────────────────────────────────────────────────

    private static async Task<IResult> CfrRunsAsync(int? limit, IDbAccess db)
    {
        var lim = Math.Min(limit ?? 30, 200);
        var runs = await db.QueryAsync<dynamic>(
            @"SELECT id, started_at, finished_at, issue_date, status, trigger_source,
                     parts_fetched, sections_total, sections_added, sections_changed,
                     sections_unchanged, duration_ms, email_sent_at,
                     LEFT(error_message, 300) AS error_message
              FROM cfr_fetch_runs
              ORDER BY started_at DESC LIMIT @Lim",
            new { Lim = lim });
        var last = await db.QueryOneAsync<dynamic>(
            @"SELECT MAX(started_at) AS last_started, MAX(issue_date) AS last_issue_date
              FROM cfr_fetch_runs WHERE status IN ('success','noop')");
        var count = await db.QueryScalarAsync<long?>(
            "SELECT COUNT(*) FROM cfr_versions WHERE is_current = 1");
        return Results.Json(new
        {
            runs,
            last_run = last,
            sections_current = count ?? 0,
        });
    }

    private static async Task<IResult> CfrVersionsAsync(string section, IDbAccess db)
    {
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT id, section, part, title, content_hash, issue_date,
                     fetched_at, is_current, superseded_at,
                     LEFT(text, 200) AS text_excerpt
              FROM cfr_versions
              WHERE section = @Section
              ORDER BY fetched_at DESC",
            new { Section = section });
        return Results.Json(new { section, versions = rows });
    }

    private static IResult CfrRunAdHocAsync()
    {
        // Stub Fase 5 — Fase 7 implementa el job runner.
        return Results.Json(new
        {
            error = "CFR run ad-hoc pendiente Fase 7. El cron del Node sigue activo si esta corriendo."
        }, statusCode: 503);
    }
}
