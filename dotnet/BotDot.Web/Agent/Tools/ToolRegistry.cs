// Registro central de las 15 tools del agente. Equivalente al
// src/agent/tools/index.js del Node.
//
// Las tools se inyectan via DI en el constructor (todas singleton — son
// stateless desde el punto de vista de la conversacion). El registry mappea
// name → ITool y expone las definitions para el request a Claude.

using System.Text.Json;

namespace BotDot.Web.Agent.Tools;

public class ToolRegistry
{
    private readonly Dictionary<string, ITool> _byName;

    public ToolRegistry(
        // Audit (3)
        LogDecisionTool logDecision, LogRefusedRequestTool logRefused, LogOffTopicTool logOffTopic,
        // Samsara (4) + assignment (1)
        SamsaraGetDriverHosTool getHos, SamsaraSearchDriverTool searchDriver,
        SamsaraGetDriversNearLimitTool nearLimit, SamsaraGetVehicleStatusTool vehStatus,
        CheckAssignmentComplianceTool checkAssign,
        // CFR (2)
        SearchCfrTool searchCfr, GetCfrSectionTool getCfr,
        // SMS (4)
        QueryBasicsStatusTool basics, QueryTopViolationsTool viols,
        QueryDriverInspectionsTool inspections, QueryDataQsCandidatesTool dataqs,
        // Escalate (1)
        EscalateToComplianceTool escalate)
    {
        _byName = new[]
        {
            (ITool)logDecision, logRefused, logOffTopic,
            getHos, searchDriver, nearLimit, vehStatus, checkAssign,
            searchCfr, getCfr,
            basics, viols, inspections, dataqs,
            escalate,
        }.ToDictionary(t => t.Definition.Name, t => t);
    }

    public IReadOnlyCollection<ToolDefinition> AllDefinitions =>
        _byName.Values.Select(t => t.Definition).ToList();

    public async Task<object?> ExecuteAsync(string name, JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        if (!_byName.TryGetValue(name, out var tool))
            return new { error = $"Herramienta desconocida: {name}" };
        return await tool.HandleAsync(input, ctx, ct);
    }

    /// <summary>
    /// Para registrar todas las tools en DI con un solo extension method.
    /// </summary>
    public static void RegisterTools(IServiceCollection services)
    {
        services.AddSingleton<LogDecisionTool>();
        services.AddSingleton<LogRefusedRequestTool>();
        services.AddSingleton<LogOffTopicTool>();
        services.AddSingleton<SamsaraGetDriverHosTool>();
        services.AddSingleton<SamsaraSearchDriverTool>();
        services.AddSingleton<SamsaraGetDriversNearLimitTool>();
        services.AddSingleton<SamsaraGetVehicleStatusTool>();
        services.AddSingleton<CheckAssignmentComplianceTool>();
        services.AddSingleton<SearchCfrTool>();
        services.AddSingleton<GetCfrSectionTool>();
        services.AddSingleton<QueryBasicsStatusTool>();
        services.AddSingleton<QueryTopViolationsTool>();
        services.AddSingleton<QueryDriverInspectionsTool>();
        services.AddSingleton<QueryDataQsCandidatesTool>();
        services.AddSingleton<EscalateToComplianceTool>();
        services.AddSingleton<CfrIndex>();
        services.AddSingleton<ToolRegistry>();
    }
}
