// 4 tools Samsara + 1 tool de assignment compliance.
// Equivalente directo a src/agent/tools/samsara.js del Node.

using System.Text.Json;

namespace BotDot.Web.Agent.Tools;

public class SamsaraGetDriverHosTool : ITool
{
    private readonly ISamsaraClient _samsara;
    public SamsaraGetDriverHosTool(ISamsaraClient s) => _samsara = s;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "samsara_get_driver_hos",
        "Consulta el estado HOS en tiempo real de un driver via Samsara API. Devuelve tiempos usados/disponibles para drive (11h), duty (14h) y cycle (70h).",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["driver_name_or_id"] = new { type = "string", description = "Nombre completo del driver o samsara_id. El sistema buscara primero por samsara_id, luego por match exacto de nombre." },
            },
            required = new[] { "driver_name_or_id" },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var query = ToolInputs.GetString(input, "driver_name_or_id") ?? "";
        var clock = await _samsara.GetDriverHosAsync(query, ct);
        if (clock == null)
            return new { error = "No se encontro driver con esa query", query };

        // Calculos de horas restantes contra los limites 49 CFR 395.3
        var driveLeftMin = Math.Max(0, 11 * 60 - clock.DrivingTimeSec / 60);
        var dutyLeftMin = Math.Max(0, 14 * 60 - clock.OnDutyTimeSec / 60);
        var cycleLeftMin = Math.Max(0, 70 * 60 - clock.CycleTimeSec / 60);

        return new
        {
            driver_id = clock.DriverId,
            driver_name = clock.DriverName,
            clock_state = clock.ClockState,
            drive_time_sec = clock.DrivingTimeSec,
            on_duty_time_sec = clock.OnDutyTimeSec,
            cycle_time_sec = clock.CycleTimeSec,
            drive_remaining_min = driveLeftMin,
            duty_remaining_min = dutyLeftMin,
            cycle_remaining_min = cycleLeftMin,
            source = "Samsara (live)",
        };
    }
}

public class SamsaraSearchDriverTool : ITool
{
    private readonly ISamsaraClient _samsara;
    public SamsaraSearchDriverTool(ISamsaraClient s) => _samsara = s;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "samsara_search_driver",
        "Busca drivers por nombre parcial. Devuelve hasta 10 matches con samsara_id y CDL info.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["query"] = new { type = "string", description = "Texto parcial del nombre" },
            },
            required = new[] { "query" },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var q = (ToolInputs.GetString(input, "query") ?? "").ToLowerInvariant();
        var all = await _samsara.ListDriversAsync(ct);
        var matches = all
            .Where(d => d.Name.ToLowerInvariant().Contains(q) || d.SamsaraId.Equals(q, StringComparison.OrdinalIgnoreCase))
            .Select(d => new
            {
                samsara_id = d.SamsaraId,
                name = d.Name,
                cdl = new { number = d.CdlNumber, state = d.CdlState, expiration = d.CdlExpiration },
                medical_card_expiration = d.MedicalCardExpiration,
                endorsements = d.Endorsements,
            })
            .Take(20)
            .ToList();
        return new { count = matches.Count, drivers = matches };
    }
}

public class SamsaraGetDriversNearLimitTool : ITool
{
    private readonly ISamsaraClient _samsara;
    public SamsaraGetDriversNearLimitTool(ISamsaraClient s) => _samsara = s;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "samsara_get_drivers_near_limit",
        "Lista drivers que estan a menos de N minutos de algun limite HOS (drive 11h, duty 14h, cycle 70h). Util para alertas proactivas de supervisor.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["threshold_minutes"] = new { type = "integer", description = "Minutos restantes para considerar \"cerca\". Default 90.", @default = 90 },
                ["limit_type"] = new
                {
                    type = "string",
                    @enum = new[] { "drive", "duty", "cycle", "any" },
                    description = "Cual limite considerar. Default any.",
                    @default = "any",
                },
            },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var threshold = ToolInputs.GetInt(input, "threshold_minutes") ?? 90;
        var limitType = ToolInputs.GetString(input, "limit_type") ?? "any";
        var clocks = await _samsara.GetHosClocksAsync(ct);
        var near = clocks
            .Select(c => new
            {
                driver_id = c.DriverId,
                driver_name = c.DriverName,
                drive_remaining_min = Math.Max(0, 11 * 60 - c.DrivingTimeSec / 60),
                duty_remaining_min = Math.Max(0, 14 * 60 - c.OnDutyTimeSec / 60),
                cycle_remaining_min = Math.Max(0, 70 * 60 - c.CycleTimeSec / 60),
                clock_state = c.ClockState,
            })
            .Where(x => limitType switch
            {
                "drive" => x.drive_remaining_min <= threshold,
                "duty" => x.duty_remaining_min <= threshold,
                "cycle" => x.cycle_remaining_min <= threshold,
                _ => x.drive_remaining_min <= threshold || x.duty_remaining_min <= threshold || x.cycle_remaining_min <= threshold,
            })
            .OrderBy(x => x.drive_remaining_min)
            .ToList();
        return new { count = near.Count, threshold_minutes = threshold, limit_type = limitType, drivers = near };
    }
}

public class SamsaraGetVehicleStatusTool : ITool
{
    private readonly ISamsaraClient _samsara;
    public SamsaraGetVehicleStatusTool(ISamsaraClient s) => _samsara = s;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "samsara_get_vehicle_status",
        "Consulta status de un vehiculo: annual inspection, OOS pendiente, mantenimiento.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["vin_or_unit"] = new { type = "string", description = "VIN o numero de unidad" },
            },
            required = new[] { "vin_or_unit" },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var q = (ToolInputs.GetString(input, "vin_or_unit") ?? "").Trim();
        var ql = q.ToLowerInvariant();
        var all = await _samsara.ListVehiclesAsync(ct);
        var v = all.FirstOrDefault(x =>
            x.SamsaraId.Equals(q, StringComparison.OrdinalIgnoreCase) ||
            x.Unit.Equals(q, StringComparison.OrdinalIgnoreCase) ||
            x.Vin.Equals(q, StringComparison.OrdinalIgnoreCase));
        if (v == null) return new { error = "Vehiculo no encontrado", query = q };
        return new
        {
            samsara_id = v.SamsaraId,
            vin = v.Vin,
            unit = v.Unit,
            make = v.Make,
            model = v.Model,
            year = v.Year,
            annual_inspection = v.AnnualInspection,
            oos = v.Oos,
        };
    }
}

/// <summary>
/// HOS rules engine — chequea una asignacion contra 49 CFR 395.3.
/// Devuelve PROCEED / CONDITIONAL / DECLINE con detalles.
/// Equivalente al check_assignment_compliance del Node.
/// </summary>
public class CheckAssignmentComplianceTool : ITool
{
    private readonly ISamsaraClient _samsara;
    public CheckAssignmentComplianceTool(ISamsaraClient s) => _samsara = s;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "check_assignment_compliance",
        "Evalua si una asignacion propuesta (driver + load) es compliant con HOS. Aplica 49 CFR 395.3 (11hr/14hr/70hr) y verifica gap. Devuelve PROCEED/CONDITIONAL/DECLINE con razon y CFR citado.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["driver_name_or_id"] = new { type = "string" },
                ["estimated_drive_minutes"] = new { type = "integer", description = "Minutos estimados de manejo del load" },
                ["load_window_minutes"] = new { type = "integer", description = "Ventana total disponible incluyendo paradas, pickup, delivery (default = drive_minutes + 120)" },
                ["load_reference"] = new { type = "string", description = "ID/referencia de la load para audit" },
            },
            required = new[] { "driver_name_or_id", "estimated_drive_minutes" },
        });

    public async Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var driver = ToolInputs.GetString(input, "driver_name_or_id") ?? "";
        var estDriveMin = ToolInputs.GetInt(input, "estimated_drive_minutes") ?? 0;

        var clock = await _samsara.GetDriverHosAsync(driver, ct);
        if (clock == null)
            return new { decision = "DECLINE", reason = "Driver no encontrado en Samsara", cfr = "395.3 (HOS check no posible)" };

        var driveLeft = Math.Max(0, 11 * 60 - clock.DrivingTimeSec / 60);
        var dutyLeft = Math.Max(0, 14 * 60 - clock.OnDutyTimeSec / 60);
        var cycleLeft = Math.Max(0, 70 * 60 - clock.CycleTimeSec / 60);

        var violations = new List<string>();
        if (estDriveMin > driveLeft) violations.Add($"49 CFR 395.3(a)(3) — limit 11hr drive (resta {driveLeft}min, asignacion pide {estDriveMin}min)");
        if (estDriveMin > dutyLeft)  violations.Add($"49 CFR 395.3(a)(2) — limit 14hr duty (resta {dutyLeft}min, asignacion pide {estDriveMin}min)");
        if (estDriveMin > cycleLeft) violations.Add($"49 CFR 395.3(b) — cycle 70hr/8days (resta {cycleLeft}min, asignacion pide {estDriveMin}min)");

        string decision;
        string reason;
        if (violations.Count > 0)
        {
            decision = "DECLINE";
            reason = string.Join(" | ", violations);
        }
        else if (estDriveMin > driveLeft - 60 || estDriveMin > dutyLeft - 60)
        {
            decision = "CONDITIONAL";
            reason = "Margen estrecho (<60min). Requiere verificar break de 30min y descansos.";
        }
        else
        {
            decision = "PROCEED";
            reason = "Dentro de limites HOS con margen razonable.";
        }

        return new
        {
            decision,
            reason,
            driver_id = clock.DriverId,
            driver_name = clock.DriverName,
            estimated_drive_min = estDriveMin,
            drive_remaining_min = driveLeft,
            duty_remaining_min = dutyLeft,
            cycle_remaining_min = cycleLeft,
            cfr = "49 CFR 395.3",
            source = "Samsara live + HOS rules engine",
        };
    }
}
