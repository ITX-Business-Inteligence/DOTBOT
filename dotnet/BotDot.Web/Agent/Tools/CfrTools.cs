// 2 tools de CFR: search_cfr y get_cfr_section.
// Lee data/cfrs/cfr-index.json (compartido con el Node) que tiene 746 secciones.
//
// Equivalente a src/agent/tools/cfr.js del Node.

using System.Text.Json;

namespace BotDot.Web.Agent.Tools;

public class CfrIndex
{
    private readonly Dictionary<string, CfrSection> _sections = new();
    private readonly ILogger<CfrIndex> _log;

    public CfrIndex(IWebHostEnvironment env, ILogger<CfrIndex> log)
    {
        _log = log;
        // El JSON vive en data/cfrs/cfr-index.json relativo al root del repo.
        // Buscamos hacia arriba desde ContentRootPath hasta encontrarlo.
        var path = FindIndexFile(env.ContentRootPath);
        if (path == null)
        {
            _log.LogWarning("cfr-index.json no encontrado — search_cfr devolvera vacio. Esperado en data/cfrs/cfr-index.json del repo.");
            return;
        }
        try
        {
            using var stream = File.OpenRead(path);
            var doc = JsonDocument.Parse(stream);
            foreach (var sec in doc.RootElement.EnumerateArray())
            {
                var s = new CfrSection
                {
                    Section = sec.GetProperty("section").GetString() ?? "",
                    Title = sec.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "",
                    Part = sec.TryGetProperty("part", out var p) ? p.GetString() ?? "" : "",
                    Text = sec.TryGetProperty("text", out var x) ? x.GetString() ?? "" : "",
                };
                if (!string.IsNullOrEmpty(s.Section)) _sections[s.Section] = s;
            }
            _log.LogInformation("CFR index cargado: {Count} secciones desde {Path}", _sections.Count, path);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Error cargando cfr-index.json");
        }
    }

    private static string? FindIndexFile(string startDir)
    {
        var dir = new DirectoryInfo(startDir);
        for (int i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "data", "cfrs", "cfr-index.json");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    public CfrSection? Get(string section) =>
        _sections.TryGetValue(section, out var s) ? s : null;

    public IReadOnlyList<CfrSection> Search(string query, int max = 10)
    {
        if (string.IsNullOrWhiteSpace(query)) return Array.Empty<CfrSection>();
        var q = query.Trim().ToLowerInvariant();
        var tokens = q.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        // Scoring matchea la heuristica del Node (cfr.js):
        //   100 — section number exact match
        //    50 — phrase exacta en title
        //    10 — token en title
        //     1 — token en body
        var scored = new List<(CfrSection sec, int score)>();
        foreach (var s in _sections.Values)
        {
            int score = 0;
            if (s.Section.Equals(query, StringComparison.OrdinalIgnoreCase)) score += 100;
            var title = s.Title.ToLowerInvariant();
            if (title.Contains(q)) score += 50;
            foreach (var tok in tokens)
            {
                if (title.Contains(tok)) score += 10;
                if (s.Text.ToLowerInvariant().Contains(tok)) score += 1;
            }
            if (score > 0) scored.Add((s, score));
        }
        return scored.OrderByDescending(x => x.score).Take(max).Select(x => x.sec).ToList();
    }
}

public class CfrSection
{
    public string Section { get; set; } = "";
    public string Title { get; set; } = "";
    public string Part { get; set; } = "";
    public string Text { get; set; } = "";
}

public class SearchCfrTool : ITool
{
    private readonly CfrIndex _idx;
    public SearchCfrTool(CfrIndex idx) => _idx = idx;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "search_cfr",
        "Busca secciones del 49 CFR Parts 380-399 (FMCSRs) por keywords. Usalo cuando necesites fundamentar una afirmacion regulatoria. Devuelve top matches con seccion, titulo y texto.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["query"] = new { type = "string", description = "Pregunta o tema a buscar (ej. \"Personal Conveyance\", \"false log\", \"annual inspection\")" },
                ["limit"] = new { type = "integer", description = "Max matches a devolver. Default 5.", @default = 5 },
            },
            required = new[] { "query" },
        });

    public Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var q = ToolInputs.GetString(input, "query") ?? "";
        var limit = ToolInputs.GetInt(input, "limit") ?? 5;
        var matches = _idx.Search(q, limit);
        return Task.FromResult<object?>(new
        {
            count = matches.Count,
            results = matches.Select(s => new
            {
                section = s.Section,
                title = s.Title,
                part = s.Part,
                excerpt = s.Text.Length > 300 ? s.Text[..300] + "..." : s.Text,
            }),
        });
    }
}

public class GetCfrSectionTool : ITool
{
    private readonly CfrIndex _idx;
    public GetCfrSectionTool(CfrIndex idx) => _idx = idx;

    public ToolDefinition Definition => ToolDefBuilder.Build(
        "get_cfr_section",
        "Devuelve el texto completo de una seccion CFR especifica.",
        new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["section"] = new { type = "string", description = "Numero de seccion (ej. \"395.3\", \"391.51\", \"382.701\")" },
            },
            required = new[] { "section" },
        });

    public Task<object?> HandleAsync(JsonElement input, ToolContext ctx, CancellationToken ct = default)
    {
        var section = ToolInputs.GetString(input, "section") ?? "";
        var s = _idx.Get(section);
        if (s == null)
            return Task.FromResult<object?>(new { error = $"Seccion {section} no esta en mi base CFR. Verifica en ecfr.gov." });
        return Task.FromResult<object?>(new
        {
            section = s.Section,
            title = s.Title,
            part = s.Part,
            text = s.Text,
            cfr_full = $"49 CFR {s.Section}",
        });
    }
}
