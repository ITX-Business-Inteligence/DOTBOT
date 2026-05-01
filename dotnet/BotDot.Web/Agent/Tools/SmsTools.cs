// 4 tools de SMS / BASICs / violaciones / crashes.
// Equivalente a src/agent/tools/sms.js del Node.
//
// Todas leen de las tablas sms_* (sms_snapshots, sms_violations, sms_inspections,
// sms_crashes). En dev sin SMS data ingestada, devuelven listas vacias y un
// mensaje claro — NO inventan numeros (regla 2 de cero alucinacion).

using System.Text.Json;
using BotDot.Web.Data;

namespace BotDot.Web.Agent.Tools;

public class QueryBasicsStatusTool : ITool
{
    private readonly IDbAccess _db;
    public QueryBasicsStatusTool(IDbAccess db) => _db = db;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "query_basics_status",
        "Devuelve el estado actual de los 7 BASICs del carrier (score, threshold, alert, months in alert) basado en el snapshot mas reciente del SMS.",
        new { type = "object", properties = new Dictionary<string, object>() });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var rows = await _db.QueryAsync<dynamic>(
            @"SELECT basic_name, score_pct, threshold_pct, alert, months_in_alert, violations_count, snapshot_date
              FROM sms_snapshots
              WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_snapshots)
              ORDER BY score_pct DESC");
        if (rows.Count == 0)
            return new { count = 0, basics = Array.Empty<object>(), note = "No hay snapshots SMS cargados (npm run ingest-sms o equivalente .NET)." };
        return new { count = rows.Count, basics = rows };
    }
}

public class QueryTopViolationsTool : ITool
{
    private readonly IDbAccess _db;
    public QueryTopViolationsTool(IDbAccess db) => _db = db;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "query_top_violations",
        "Top N violaciones por puntos totales en un BASIC (o todos). Util para Pareto y plan de mitigacion.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["basic"] = new { type = "string", description = "Nombre del BASIC o \"all\" para todos. Default all." },
                ["limit"] = new { type = "integer", @default = 15 },
            },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var basic = ToolInputs.GetString(input, "basic");
        if (basic == "all") basic = null;
        var limit = Math.Min(50, ToolInputs.GetInt(input, "limit") ?? 15);
        string sql = @"SELECT basic_name, viol_code, description, total_points, count_inst
                       FROM sms_violations
                       WHERE 1=1 " + (basic != null ? "AND basic_name = @Basic " : "") +
                     "ORDER BY total_points DESC LIMIT @Limit";
        var rows = await _db.QueryAsync<dynamic>(sql, new { Basic = basic, Limit = limit });
        return new { count = rows.Count, violations = rows };
    }
}

public class QueryDriverInspectionsTool : ITool
{
    private readonly IDbAccess _db;
    public QueryDriverInspectionsTool(IDbAccess db) => _db = db;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "query_driver_inspections",
        "Lista inspecciones recientes de un driver (por nombre) con sus violaciones. Util para coaching y patrones.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["driver_name"] = new { type = "string" },
                ["days"] = new { type = "integer", description = "Ventana en dias. Default 365.", @default = 365 },
            },
            required = new[] { "driver_name" },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var name = (ToolInputs.GetString(input, "driver_name") ?? "").Trim();
        if (name.Length < 3) return new { error = "driver_name muy corto, minimo 3 chars" };
        var rows = await _db.QueryAsync<dynamic>(
            @"SELECT inspection_date, level, state, oos_total, viol_total, driver_name, vehicle_unit
              FROM sms_inspections
              WHERE driver_name LIKE @Q
              ORDER BY inspection_date DESC LIMIT 30",
            new { Q = $"%{name}%" });
        return new { count = rows.Count, inspections = rows };
    }
}

public class QueryDataQsCandidatesTool : ITool
{
    private readonly IDbAccess _db;
    public QueryDataQsCandidatesTool(IDbAccess db) => _db = db;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "query_dataqs_candidates",
        "Lista crashes que NO han sido disputados via DataQs y que potencialmente podrian ser Not Preventable. Util para sweep de DataQs.",
        new { type = "object", properties = new Dictionary<string, object>() });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var rows = await _db.QueryAsync<dynamic>(
            @"SELECT id, crash_date, severity, dataqs_disputed, not_preventable, narrative
              FROM sms_crashes
              WHERE dataqs_disputed = 0 AND (not_preventable IS NULL OR not_preventable = 0)
              ORDER BY crash_date DESC LIMIT 50");
        return new { count = rows.Count, candidates = rows };
    }
}
