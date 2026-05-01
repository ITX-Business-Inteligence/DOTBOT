// Endpoints /api/analytics/* — admin/compliance/manager.
// Equivalente a src/routes/analytics.js Node.
//
// Todos aceptan ?period={1d,7d,30d}; default 7d.

using BotDot.Web.Auth;
using BotDot.Web.Data;

namespace BotDot.Web.Routes;

public static class AnalyticsEndpoints
{
    private static readonly Dictionary<string, int> PeriodHours = new()
    {
        ["1d"] = 24,
        ["7d"] = 24 * 7,
        ["30d"] = 24 * 30,
    };

    private static int HoursFor(string? period) =>
        PeriodHours.TryGetValue(period ?? "7d", out var h) ? h : 24 * 7;

    public static void MapAnalyticsEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/analytics")
            .AddEndpointFilter(new RequireAuthFilter(Roles.Admin, Roles.Compliance, Roles.Manager));

        grp.MapGet("/overview", OverviewAsync);
        grp.MapGet("/usage-over-time", UsageOverTimeAsync);
        grp.MapGet("/by-role", ByRoleAsync);
        grp.MapGet("/top-users", TopUsersAsync);
        grp.MapGet("/top-tools", TopToolsAsync);
        grp.MapGet("/decisions", DecisionsAsync);
        grp.MapGet("/hour-heatmap", HourHeatmapAsync);
        grp.MapGet("/topics", TopicsAsync);
        grp.MapGet("/cost", CostAsync);
        grp.MapGet("/refused", RefusedAsync);
    }

    private static async Task<IResult> OverviewAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        var queries = await db.QueryScalarAsync<long?>(
            "SELECT COUNT(*) FROM messages WHERE role='user' AND created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)",
            new { H = h });
        var users = await db.QueryScalarAsync<long?>(
            @"SELECT COUNT(DISTINCT c.user_id) FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
              WHERE m.role='user' AND m.created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)",
            new { H = h });
        var avgLatency = await db.QueryScalarAsync<double?>(
            @"SELECT AVG(latency_ms) FROM messages
              WHERE role='assistant' AND latency_ms IS NOT NULL
                AND created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)",
            new { H = h });
        return Results.Json(new
        {
            queries = queries ?? 0,
            unique_users = users ?? 0,
            avg_latency_ms = avgLatency.HasValue ? Math.Round(avgLatency.Value) : 0,
            period,
        });
    }

    private static async Task<IResult> UsageOverTimeAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT DATE(created_at) AS day, COUNT(*) AS queries
              FROM messages
              WHERE role='user' AND created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              GROUP BY DATE(created_at) ORDER BY day ASC",
            new { H = h });
        return Results.Json(new { series = rows });
    }

    private static async Task<IResult> ByRoleAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT u.role, COUNT(*) AS queries
              FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
              JOIN users u ON u.id = c.user_id
              WHERE m.role='user' AND m.created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              GROUP BY u.role ORDER BY queries DESC",
            new { H = h });
        return Results.Json(new { by_role = rows });
    }

    private static async Task<IResult> TopUsersAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT u.id, u.full_name, u.role,
                     COUNT(*) AS queries,
                     COUNT(DISTINCT c.id) AS conversations,
                     MAX(m.created_at) AS last_active
              FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
              JOIN users u ON u.id = c.user_id
              WHERE m.role='user' AND m.created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              GROUP BY u.id, u.full_name, u.role
              ORDER BY queries DESC LIMIT 20",
            new { H = h });
        return Results.Json(new { users = rows });
    }

    private static async Task<IResult> TopToolsAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        // Los messages role='tool_use' tienen content_json con { name, input, result }.
        // JSON_EXTRACT en MySQL para sacar el name.
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT JSON_UNQUOTE(JSON_EXTRACT(content_json, '$.name')) AS tool_name,
                     COUNT(*) AS calls
              FROM messages
              WHERE role='tool_use' AND created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              GROUP BY tool_name
              ORDER BY calls DESC
              LIMIT 20",
            new { H = h });
        return Results.Json(new { tools = rows });
    }

    private static async Task<IResult> DecisionsAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT decision, COUNT(*) AS count
              FROM audit_log
              WHERE decision IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              GROUP BY decision",
            new { H = h });
        return Results.Json(new { decisions = rows });
    }

    private static async Task<IResult> HourHeatmapAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT DAYOFWEEK(created_at) AS dow, HOUR(created_at) AS hour, COUNT(*) AS count
              FROM messages
              WHERE role='user' AND created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              GROUP BY dow, hour",
            new { H = h });
        return Results.Json(new { heatmap = rows });
    }

    private static async Task<IResult> TopicsAsync(string? period, IDbAccess db)
    {
        // Stub minimo: top words via parsing simple del content_json.text.
        // El Node hace tokenizing y filtering — version corta aca.
        var h = HoursFor(period);
        var msgs = await db.QueryAsync<MessageContentRow>(
            @"SELECT content_json AS ContentJson FROM messages
              WHERE role='user' AND created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              LIMIT 1000",
            new { H = h });

        var stop = new HashSet<string> { "el","la","los","las","de","del","y","o","a","en","es","un","una","con","por","para","que","como","si","no","se","mi","tu","su","al","lo","ya","mas","muy","esto","esta","yo","te","me","ese","esa" };
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var prompts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        foreach (var m in msgs)
        {
            if (string.IsNullOrEmpty(m.ContentJson)) continue;
            string? text = null;
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(m.ContentJson);
                if (doc.RootElement.TryGetProperty("text", out var t) &&
                    t.ValueKind == System.Text.Json.JsonValueKind.String)
                    text = t.GetString();
            }
            catch { continue; }
            if (string.IsNullOrEmpty(text)) continue;

            var truncated = text.Length > 80 ? text[..80] : text;
            prompts[truncated] = prompts.GetValueOrDefault(truncated) + 1;

            foreach (var w in System.Text.RegularExpressions.Regex.Split(text.ToLowerInvariant(), @"[^\w]+"))
            {
                if (w.Length < 4 || stop.Contains(w)) continue;
                counts[w] = counts.GetValueOrDefault(w) + 1;
            }
        }

        var topWords = counts.OrderByDescending(kv => kv.Value).Take(40)
            .Select(kv => new { word = kv.Key, count = kv.Value });
        var repeated = prompts.Where(kv => kv.Value >= 2)
            .OrderByDescending(kv => kv.Value).Take(20)
            .Select(kv => new { title = kv.Key, count = kv.Value });

        return Results.Json(new { top_words = topWords, repeated_prompts = repeated });
    }

    private class MessageContentRow { public string? ContentJson { get; set; } }

    private static async Task<IResult> CostAsync(string? period, IDbAccess db, BotDot.Web.Agent.BudgetService budget)
    {
        var h = HoursFor(period);
        // Reuso BudgetService.SpendUsdAsync via reflection... no. Simplemente
        // calculo aca con el mismo pricing.
        var sums = await db.QueryOneAsync<TokenSums>(
            @"SELECT
                COALESCE(SUM(tokens_input), 0)        AS TokensInput,
                COALESCE(SUM(tokens_output), 0)       AS TokensOutput,
                COALESCE(SUM(tokens_cache_read), 0)   AS TokensCacheRead,
                COALESCE(SUM(tokens_cache_create), 0) AS TokensCacheCreate
              FROM messages
              WHERE created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)",
            new { H = h });
        sums ??= new TokenSums();

        // Pricing claude-sonnet-4-6 (USD per 1M tokens):
        decimal cost =
            (sums.TokensInput / 1_000_000m) * 3m +
            (sums.TokensOutput / 1_000_000m) * 15m +
            (sums.TokensCacheRead / 1_000_000m) * 0.30m +
            (sums.TokensCacheCreate / 1_000_000m) * 3.75m;

        // Proyeccion mensual lineal (asumiendo periodo continua a la misma tasa)
        var hours = h;
        var monthly = hours > 0 ? cost * (24m * 30m / hours) : 0m;

        return Results.Json(new
        {
            estimated_cost_usd = Math.Round(cost, 2),
            estimated_monthly_usd = Math.Round(monthly, 2),
            tokens_input = sums.TokensInput,
            tokens_output = sums.TokensOutput,
            tokens_cache_read = sums.TokensCacheRead,
            tokens_cache_create = sums.TokensCacheCreate,
        });
    }

    private class TokenSums
    {
        public long TokensInput { get; set; }
        public long TokensOutput { get; set; }
        public long TokensCacheRead { get; set; }
        public long TokensCacheCreate { get; set; }
    }

    private static async Task<IResult> RefusedAsync(string? period, IDbAccess db)
    {
        var h = HoursFor(period);
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT a.id, a.action_type, a.cfr_cited, a.reasoning, a.created_at,
                     u.full_name AS user_name, u.role AS user_role,
                     a.evidence_json AS evidence
              FROM audit_log a
              JOIN users u ON u.id = a.user_id
              WHERE a.decision = 'decline' AND a.created_at >= DATE_SUB(NOW(), INTERVAL @H HOUR)
              ORDER BY a.id DESC LIMIT 100",
            new { H = h });
        return Results.Json(new { refused = rows });
    }
}
