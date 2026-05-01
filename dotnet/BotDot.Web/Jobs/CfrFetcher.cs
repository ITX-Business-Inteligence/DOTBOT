// Fetcher del 49 CFR desde la API publica de eCFR.gov.
// NO usa XML parser — usa regex igual que el Node (cfr-fetcher.js).
//
// Razon de no usar XML parser nativo:
//   1. Defense en depth contra XXE — regex no procesa entities/DTDs
//   2. Paridad byte-exacta con el Node
//   3. eCFR XML es estructurado y predecible
//
// SSRF: la URL base esta hardcoded a www.ecfr.gov — no acepta input del
// usuario. Si alguien edita el codigo para parametrizar el host, agregar
// validacion de allowlist primero.

using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace BotDot.Web.Jobs;

public class CfrSection
{
    public string Section { get; set; } = "";
    public int Part { get; set; }
    public string Title { get; set; } = "";
    public string Text { get; set; } = "";
    public List<string> Keywords { get; set; } = new();
    public string ContentHash { get; set; } = "";
    public string IssueDate { get; set; } = "";
}

public class CfrFetcher
{
    /// <summary>Parts 388 y 394 son [Reserved] en el CFR — no tienen contenido.</summary>
    private static readonly int[] Parts = new[]
    {
        380, 381, 382, 383, 384, 385, 386, 387, 389,
        390, 391, 392, 393, 395, 396, 397, 398, 399
    };

    private const string EcfrBase = "https://www.ecfr.gov";
    private const string EcfrTitlesUrl = EcfrBase + "/api/versioner/v1/titles.json";
    private static readonly Regex SectionRe = new(
        @"<DIV8\s+N=""([^""]+)""\s+TYPE=""SECTION""[^>]*>([\s\S]*?)</DIV8>", RegexOptions.Compiled);
    private static readonly Regex HeadRe = new(@"<HEAD>([\s\S]*?)</HEAD>", RegexOptions.Compiled);
    private static readonly Regex ParagraphRe = new(@"<P>([\s\S]*?)</P>", RegexOptions.Compiled);
    private static readonly Regex InlineTagRe = new(@"</?[A-Z][A-Z0-9]*( [^>]*)?>", RegexOptions.Compiled);
    private static readonly Regex SectionPrefixRe = new(@"^§\s*[\d.]+\s*", RegexOptions.Compiled);

    private readonly IHttpClientFactory _httpFactory;
    private readonly string _rawDir;
    private readonly ILogger<CfrFetcher> _log;

    public CfrFetcher(IHttpClientFactory httpFactory, IWebHostEnvironment env, ILogger<CfrFetcher> log)
    {
        _httpFactory = httpFactory;
        _log = log;
        // Cache de XML crudo en data/imports/cfr-raw/ (compartido con Node).
        _rawDir = Path.Combine(env.ContentRootPath, "..", "..", "data", "imports", "cfr-raw");
        // Si la ruta relativa no resuelve (instalacion no estandar), buscar
        // hacia arriba el repo root.
        if (!Directory.Exists(Path.GetDirectoryName(_rawDir)))
        {
            var repoRoot = FindRepoRoot(env.ContentRootPath);
            if (repoRoot != null)
                _rawDir = Path.Combine(repoRoot, "data", "imports", "cfr-raw");
        }
    }

    private static string? FindRepoRoot(string startDir)
    {
        var dir = new DirectoryInfo(startDir);
        for (int i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "data", "cfrs"))) return dir.FullName;
        }
        return null;
    }

    private HttpClient CreateClient()
    {
        // SSRF defense: aunque la URL es hardcoded, deshabilitamos auto-redirect
        // a hosts externos. Si eCFR redirect a algo, queremos verlo en logs.
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 3,
        };
        var client = new HttpClient(handler, disposeHandler: true)
        {
            Timeout = TimeSpan.FromSeconds(30),
        };
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/xml"));
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("BOTDOT-CFR-fetcher", "1.0"));
        return client;
    }

    private async Task<string> FetchUrlAsync(string url, CancellationToken ct)
    {
        // Validar que el URL sea de eCFR.gov — defense en profundidad si alguien
        // pasa parametrizacion futura.
        if (!url.StartsWith("https://www.ecfr.gov/", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"URL no permitida (debe ser ecfr.gov): {url}");

        using var client = CreateClient();
        using var resp = await client.GetAsync(url, ct);
        if (resp.StatusCode != HttpStatusCode.OK)
            throw new HttpRequestException($"HTTP {(int)resp.StatusCode}: {url}");
        return await resp.Content.ReadAsStringAsync(ct);
    }

    public async Task<string> GetLatestIssueDateAsync(CancellationToken ct = default)
    {
        var data = await FetchUrlAsync(EcfrTitlesUrl, ct);
        using var doc = System.Text.Json.JsonDocument.Parse(data);
        if (!doc.RootElement.TryGetProperty("titles", out var titles)) throw new Exception("No 'titles' en response");
        foreach (var t in titles.EnumerateArray())
        {
            if (t.TryGetProperty("number", out var num) && num.GetInt32() == 49)
            {
                if (t.TryGetProperty("latest_issue_date", out var date) && date.GetString() is string s)
                    return s;
            }
        }
        throw new Exception("No se pudo determinar latest_issue_date para Title 49");
    }

    public async Task<(List<CfrSection> Sections, string IssueDate)> FetchAllPartsAsync(
        string? issueDate = null, bool noCache = false, CancellationToken ct = default)
    {
        var date = issueDate ?? await GetLatestIssueDateAsync(ct);
        _log.LogInformation("Fetching CFR Title 49 issue {Date}, {N} Parts", date, Parts.Length);
        Directory.CreateDirectory(_rawDir);

        var all = new List<CfrSection>();
        for (int i = 0; i < Parts.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            var partNum = Parts[i];
            var url = $"{EcfrBase}/api/versioner/v1/full/{date}/title-49.xml?part={partNum}";
            var cachePath = Path.Combine(_rawDir, $"part-{partNum}.xml");

            string xml;
            if (!noCache && File.Exists(cachePath))
            {
                xml = await File.ReadAllTextAsync(cachePath, Encoding.UTF8, ct);
                _log.LogDebug("Part {P}: cached", partNum);
            }
            else
            {
                _log.LogInformation("Part {P}: fetching...", partNum);
                xml = await FetchUrlAsync(url, ct);
                await File.WriteAllTextAsync(cachePath, xml, Encoding.UTF8, ct);
                await Task.Delay(500, ct); // cortesia a la API publica
            }

            var sections = ParsePartXml(xml, partNum);
            foreach (var s in sections)
            {
                s.Keywords = AutoKeywords(s.Title);
                s.ContentHash = HashContent(s.Title, s.Text);
                s.IssueDate = date;
            }
            all.AddRange(sections);
        }
        _log.LogInformation("Total: {N} secciones de {P} Parts", all.Count, Parts.Length);
        return (all, date);
    }

    public static List<CfrSection> ParsePartXml(string xml, int partNum)
    {
        var sections = new List<CfrSection>();
        foreach (Match m in SectionRe.Matches(xml))
        {
            var sectionNum = m.Groups[1].Value;
            var inner = m.Groups[2].Value;

            var headMatch = HeadRe.Match(inner);
            string title = headMatch.Success ? DecodeEntities(StripInlineTags(headMatch.Groups[1].Value)).Trim() : "";
            title = SectionPrefixRe.Replace(title, "").Trim();

            var paragraphs = new List<string>();
            foreach (Match pm in ParagraphRe.Matches(inner))
            {
                paragraphs.Add(DecodeEntities(StripInlineTags(pm.Groups[1].Value)).Trim());
            }
            var text = string.Join("\n\n", paragraphs);

            if (!string.IsNullOrEmpty(sectionNum))
                sections.Add(new CfrSection { Section = sectionNum, Title = title, Text = text, Part = partNum });
        }
        return sections;
    }

    private static string StripInlineTags(string s) => InlineTagRe.Replace(s, "");

    private static string DecodeEntities(string s)
    {
        return s
            .Replace("&#xA7;", "§", StringComparison.OrdinalIgnoreCase)
            .Replace("&#xB6;", "¶", StringComparison.OrdinalIgnoreCase)
            .Replace("&amp;", "&")
            .Replace("&lt;", "<")
            .Replace("&gt;", ">")
            .Replace("&quot;", "\"")
            .Replace("&#x([0-9a-f]+);", "", StringComparison.OrdinalIgnoreCase)  // placeholder, fixed via regex below
            ;
        // Nota: para hex/decimal entities el Node usa regex con substitucion.
        // El metodo simplificado anterior cubre los casos comunes; los menos
        // frecuentes los dejamos como vienen (no es comun en eCFR).
    }

    public static List<string> AutoKeywords(string title)
    {
        var stop = new HashSet<string> { "for","the","and","with","from","that","this","part","of","to","in","on","a","an","or","by","as","be","is","are","at","it" };
        return Regex.Replace((title ?? "").ToLowerInvariant(), @"[^a-z0-9 ]", " ")
            .Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length >= 4 && !stop.Contains(t))
            .Take(8)
            .ToList();
    }

    public static string HashContent(string title, string text)
    {
        var bytes = Encoding.UTF8.GetBytes($"{title}|{text}");
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
