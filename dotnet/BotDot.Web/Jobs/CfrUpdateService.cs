// Job de actualizacion del CFR — cron daily 4am.
// Equivalente a src/jobs/cfr-update.js Node.

using System.Text.Json;
using BotDot.Web.Audit;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using BotDot.Web.Email;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Jobs;

public class CfrUpdateService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly JobsOptions _opts;
    private readonly ILogger<CfrUpdateService> _log;

    public CfrUpdateService(IServiceProvider services, IOptions<BotDotOptions> opts, ILogger<CfrUpdateService> log)
    {
        _services = services;
        _opts = opts.Value.Jobs;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_opts.Enabled || !_opts.CfrUpdateEnabled)
        {
            _log.LogInformation("CfrUpdateService deshabilitado (BotDot:Jobs:CfrUpdateEnabled=false)");
            return;
        }
        _log.LogInformation("CfrUpdateService iniciado (cron diario {At})", _opts.CfrUpdateAt);

        try { await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken); } catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            var nextRun = ExpirationAlertsService.NextRunAt(_opts.CfrUpdateAt);
            var wait = nextRun - DateTime.Now;
            if (wait < TimeSpan.Zero) wait = TimeSpan.FromMinutes(1);
            _log.LogInformation("CfrUpdate: proxima corrida {Next} (en {Wait})", nextRun, wait);
            try { await Task.Delay(wait, stoppingToken); } catch (OperationCanceledException) { return; }

            try { await RunAsync("cron", null, stoppingToken); }
            catch (Exception ex) { _log.LogError(ex, "CfrUpdate run fallo (continua)"); }
        }
    }

    /// <summary>
    /// Ejecuta una corrida del job. Disponible ad-hoc desde /api/admin/cfr/run.
    /// </summary>
    public async Task<RunResult> RunAsync(string trigger = "manual", string? issueDateOverride = null, CancellationToken ct = default)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IDbAccess>();
        var fetcher = scope.ServiceProvider.GetRequiredService<CfrFetcher>();
        var audit = scope.ServiceProvider.GetRequiredService<IAuditService>();
        var email = scope.ServiceProvider.GetRequiredService<IEmailService>();
        var opts = scope.ServiceProvider.GetRequiredService<IOptions<BotDotOptions>>().Value;

        var baseline = await IsBaselineAsync(db);
        var triggerSource = baseline ? "baseline" : trigger;

        var runId = await db.ExecuteInsertAsync(
            "INSERT INTO cfr_fetch_runs (status, trigger_source) VALUES ('running', @T)",
            new { T = triggerSource });

        var t0 = DateTime.UtcNow;
        try
        {
            var (fetched, issue) = await fetcher.FetchAllPartsAsync(issueDateOverride, false, ct);
            var currentMap = await GetCurrentByHashAsync(db);

            int added = 0, changed = 0, unchanged = 0;
            var changes = new List<ChangeInfo>();
            var addedSections = new List<AddedInfo>();

            await db.TransactionAsync<object?>(async (conn, tx) =>
            {
                foreach (var sec in fetched)
                {
                    if (currentMap.TryGetValue(sec.Section, out var existing) && existing.ContentHash == sec.ContentHash)
                    {
                        unchanged++;
                        continue;
                    }

                    if (existing != null)
                    {
                        await Dapper.SqlMapper.ExecuteAsync(conn,
                            @"UPDATE cfr_versions
                              SET is_current = 0, superseded_at = CURRENT_TIMESTAMP(6)
                              WHERE id = @Id",
                            new { Id = existing.Id }, tx);
                        var old = await Dapper.SqlMapper.QueryFirstOrDefaultAsync<dynamic>(conn,
                            "SELECT title, fetched_at FROM cfr_versions WHERE id = @Id",
                            new { Id = existing.Id }, tx);
                        changes.Add(new ChangeInfo
                        {
                            Section = sec.Section,
                            Title = sec.Title,
                            PreviousFetchedAt = ((DateTime?)old?.fetched_at)?.ToString("O"),
                        });
                        changed++;
                    }
                    else
                    {
                        addedSections.Add(new AddedInfo { Section = sec.Section, Title = sec.Title });
                        added++;
                    }

                    await Dapper.SqlMapper.ExecuteAsync(conn,
                        @"INSERT INTO cfr_versions
                            (section, part, title, text, keywords_json, content_hash, issue_date, is_current)
                          VALUES (@Section, @Part, @Title, @Text, @Kw, @Hash, @Issue, 1)
                          ON DUPLICATE KEY UPDATE
                            is_current = 1, superseded_at = NULL",
                        new
                        {
                            sec.Section, sec.Part, sec.Title, sec.Text,
                            Kw = JsonSerializer.Serialize(sec.Keywords),
                            Hash = sec.ContentHash,
                            Issue = issue,
                        }, tx);
                }
                return null;
            });

            // Regenerar JSON consumido por search_cfr / get_cfr_section tools
            await RegenerateJsonFromDbAsync(db);

            var elapsed = (long)(DateTime.UtcNow - t0).TotalMilliseconds;
            var finalStatus = (changes.Count == 0 && added == 0) ? "noop" : "success";

            await db.ExecuteAsync(
                @"UPDATE cfr_fetch_runs
                  SET finished_at = CURRENT_TIMESTAMP(6),
                      issue_date = @Issue,
                      status = @Status,
                      parts_fetched = 18,
                      sections_total = @Total,
                      sections_added = @Added,
                      sections_changed = @Changed,
                      sections_unchanged = @Unchanged,
                      duration_ms = @Dur
                  WHERE id = @Id",
                new
                {
                    Issue = issue,
                    Status = finalStatus,
                    Total = fetched.Count,
                    Added = added,
                    Changed = changed,
                    Unchanged = unchanged,
                    Dur = elapsed,
                    Id = runId,
                });

            // En baseline NO mandamos email ni audit (carga inicial)
            if (!baseline && (changes.Count > 0 || addedSections.Count > 0))
            {
                try
                {
                    await audit.AppendAsync(new AuditEntry
                    {
                        UserId = 1,
                        ActionType = "cfr_update",
                        SubjectType = "cfr",
                        SubjectId = issue,
                        Decision = "informational",
                        Reasoning = $"CFR update aplicado: {changes.Count} secciones modificadas, {added} nuevas (issue {issue})",
                        Evidence = new Dictionary<string, object?>
                        {
                            ["issue_date"] = issue,
                            ["changes"] = changes.Select(c => new { section = c.Section, title = c.Title }),
                            ["added"] = addedSections,
                            ["unchanged_count"] = unchanged,
                        },
                    }, ct);
                }
                catch (Exception ex) { _log.LogError(ex, "audit failed"); }

                try { await SendChangesEmailAsync(runId, changes, addedSections, issue, email, db, opts, ct); }
                catch (Exception ex) { _log.LogError(ex, "email failed"); }
            }

            return new RunResult
            {
                RunId = runId,
                Status = finalStatus,
                IssueDate = issue,
                SectionsTotal = fetched.Count,
                SectionsAdded = added,
                SectionsChanged = changed,
                SectionsUnchanged = unchanged,
                DurationMs = elapsed,
                Baseline = baseline,
            };
        }
        catch (Exception ex)
        {
            var elapsed = (long)(DateTime.UtcNow - t0).TotalMilliseconds;
            var msg = ex.Message;
            if (msg.Length > 1000) msg = msg[..1000];
            await db.ExecuteAsync(
                @"UPDATE cfr_fetch_runs
                  SET finished_at = CURRENT_TIMESTAMP(6), status = 'error',
                      duration_ms = @Dur, error_message = @Err
                  WHERE id = @Id",
                new { Dur = elapsed, Err = msg, Id = runId });
            _log.LogError(ex, "CfrUpdate fallo");
            throw;
        }
    }

    private static async Task<bool> IsBaselineAsync(IDbAccess db)
    {
        var n = await db.QueryScalarAsync<long?>("SELECT COUNT(*) FROM cfr_versions");
        return (n ?? 0) == 0;
    }

    private static async Task<Dictionary<string, CurrentVersionRow>> GetCurrentByHashAsync(IDbAccess db)
    {
        var rows = await db.QueryAsync<CurrentVersionRow>(
            "SELECT id AS Id, section AS Section, content_hash AS ContentHash FROM cfr_versions WHERE is_current = 1");
        return rows.ToDictionary(r => r.Section);
    }

    private async Task<int> RegenerateJsonFromDbAsync(IDbAccess db)
    {
        var rows = await db.QueryAsync<CfrJsonRow>(
            @"SELECT section AS Section, part AS Part, title AS Title, text AS Text,
                     keywords_json AS KeywordsJson
              FROM cfr_versions
              WHERE is_current = 1
              ORDER BY part ASC, section ASC");

        var output = rows.Select(r => new
        {
            section = r.Section,
            part = r.Part,
            title = r.Title,
            text = r.Text,
            keywords = !string.IsNullOrEmpty(r.KeywordsJson)
                ? JsonSerializer.Deserialize<List<string>>(r.KeywordsJson) ?? new()
                : new List<string>(),
        }).ToList();

        // Path al cfr-index.json compartido con el Node
        var jsonPath = FindCfrIndexPath();
        if (jsonPath != null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(jsonPath)!);
            await File.WriteAllTextAsync(jsonPath, JsonSerializer.Serialize(output));
            _log.LogInformation("CFR index JSON regenerado: {Path} ({N} secciones)", jsonPath, output.Count);
        }
        return output.Count;
    }

    private static string? FindCfrIndexPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "data", "cfrs", "cfr-index.json");
            if (File.Exists(candidate)) return candidate;
            // Tambien permitir crear el archivo si la carpeta existe
            var cfrsDir = Path.Combine(dir.FullName, "data", "cfrs");
            if (Directory.Exists(cfrsDir)) return candidate;
        }
        return null;
    }

    private static async Task SendChangesEmailAsync(
        long runId, List<ChangeInfo> changes, List<AddedInfo> added,
        string issueDate, IEmailService email, IDbAccess db,
        BotDotOptions opts, CancellationToken ct)
    {
        if (changes.Count == 0 && added.Count == 0) return;

        var to = await GetRecipientsAsync(db, opts);
        if (to.Count == 0) return;

        var totalNotices = changes.Count + added.Count;
        var subject = $"[CRITICAL] BOTDOT — {totalNotices} cambios en 49 CFR (issue {issueDate})";

        var linesChanged = changes.Count > 0
            ? string.Join("\n", changes.Select(c => $"  - {c.Section}: {c.Title}\n    (texto modificado vs version del {c.PreviousFetchedAt})"))
            : "  (ninguna)";
        var linesAdded = added.Count > 0
            ? string.Join("\n", added.Select(s => $"  - {s.Section}: {s.Title}\n    (NUEVA seccion)"))
            : "  (ninguna)";

        var text =
$@"Cambios detectados en 49 CFR Parts 380-399 (issue {issueDate}):

{changes.Count} secciones modificadas:
{linesChanged}

{added.Count} secciones nuevas:
{linesAdded}

El bot ya esta usando las versiones nuevas. Las versiones anteriores quedan en
el historial (cfr_versions) para audit trail.

Revisar impacto operacional en: {opts.PublicUrl}/settings.html#sistema

— BOTDOT (no respondas a este email)
";

        var result = await email.SendAsync(new EmailMessage { To = to, Subject = subject, Text = text }, ct);
        if (result.Sent)
        {
            await db.ExecuteAsync(
                "UPDATE cfr_fetch_runs SET email_sent_at = CURRENT_TIMESTAMP WHERE id = @Id",
                new { Id = runId });
        }
    }

    private static async Task<List<string>> GetRecipientsAsync(IDbAccess db, BotDotOptions opts)
    {
        if (!string.IsNullOrEmpty(opts.Email.EscalationsTo))
        {
            return opts.Email.EscalationsTo
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
        }
        var rows = await db.QueryAsync<string>(
            "SELECT email FROM users WHERE role = 'compliance' AND active = 1");
        return rows.ToList();
    }

    public class RunResult
    {
        public long RunId { get; set; }
        public string Status { get; set; } = "";
        public string IssueDate { get; set; } = "";
        public int SectionsTotal { get; set; }
        public int SectionsAdded { get; set; }
        public int SectionsChanged { get; set; }
        public int SectionsUnchanged { get; set; }
        public long DurationMs { get; set; }
        public bool Baseline { get; set; }
    }

    private class CurrentVersionRow
    {
        public long Id { get; set; }
        public string Section { get; set; } = "";
        public string ContentHash { get; set; } = "";
    }

    private class CfrJsonRow
    {
        public string? Section { get; set; }
        public string? Part { get; set; }
        public string? Title { get; set; }
        public string? Text { get; set; }
        public string? KeywordsJson { get; set; }
    }

    private class ChangeInfo
    {
        public string Section { get; set; } = "";
        public string Title { get; set; } = "";
        public string? PreviousFetchedAt { get; set; }
    }

    private class AddedInfo
    {
        public string Section { get; set; } = "";
        public string Title { get; set; } = "";
    }
}
