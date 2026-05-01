// Job de alertas proactivas de expiracion CDL/medical card.
// Equivalente a src/jobs/expiration-alerts.js Node.
//
// Cron: configurable via BotDot:Jobs:ExpirationAlertsAt (default 06:00).
// Tambien via BotDot:Jobs:AlertsIntervalMinutes (override para dev — corre cada N min en lugar de diario).
//
// Logica:
//   - Por cada driver activo con cdl_expiration o medical_card_expiration
//     en el horizonte (60d), calcular dias_restantes y bucket-ear contra
//     thresholds: [60, 30, 14, 7, 0, -1].
//   - UNIQUE(kind, subject_id, threshold) en notifications evita duplicados.
//   - Email a compliance + audit + INSERT.

using BotDot.Web.Audit;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using BotDot.Web.Email;
using Microsoft.Extensions.Options;
using MySqlConnector;

namespace BotDot.Web.Jobs;

public class ExpirationAlertsService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly JobsOptions _opts;
    private readonly ILogger<ExpirationAlertsService> _log;

    public ExpirationAlertsService(IServiceProvider services, IOptions<BotDotOptions> opts, ILogger<ExpirationAlertsService> log)
    {
        _services = services;
        _opts = opts.Value.Jobs;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_opts.Enabled)
        {
            _log.LogInformation("ExpirationAlertsService deshabilitado (BotDot:Jobs:Enabled=false)");
            return;
        }
        _log.LogInformation("ExpirationAlertsService iniciado (cron diario {At})", _opts.ExpirationAlertsAt);

        try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken); } catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            var nextRun = NextRunAt(_opts.ExpirationAlertsAt);
            var wait = nextRun - DateTime.Now;
            if (wait < TimeSpan.Zero) wait = TimeSpan.FromMinutes(1);
            _log.LogInformation("ExpirationAlerts: proxima corrida {Next} (en {Wait})", nextRun, wait);
            try { await Task.Delay(wait, stoppingToken); } catch (OperationCanceledException) { return; }

            try { await RunAsync(stoppingToken); }
            catch (Exception ex) { _log.LogError(ex, "ExpirationAlerts run fallo (continua)"); }
        }
    }

    /// <summary>Helper para calcular el siguiente datetime que matchea HH:MM hoy o manana.</summary>
    public static DateTime NextRunAt(string hhmm)
    {
        if (!TimeSpan.TryParse(hhmm, out var time)) time = TimeSpan.FromHours(6);
        var today = DateTime.Today.Add(time);
        return DateTime.Now < today ? today : today.AddDays(1);
    }

    /// <summary>
    /// Ejecuta una corrida del scan. Disponible para invocacion ad-hoc desde
    /// el endpoint /api/notifications/run-job (admin only).
    /// </summary>
    public async Task<RunResult> RunAsync(CancellationToken ct = default)
    {
        var t0 = DateTime.UtcNow;
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IDbAccess>();
        var audit = scope.ServiceProvider.GetRequiredService<IAuditService>();
        var email = scope.ServiceProvider.GetRequiredService<IEmailService>();
        var emailOpts = scope.ServiceProvider.GetRequiredService<IOptions<BotDotOptions>>().Value;

        var drivers = await db.QueryAsync<DriverExpRow>(
            @"SELECT id AS Id, samsara_id AS SamsaraId, full_name AS FullName,
                     cdl_expiration AS CdlExpiration,
                     medical_card_expiration AS MedicalCardExpiration,
                     DATEDIFF(cdl_expiration, CURDATE())          AS CdlDays,
                     DATEDIFF(medical_card_expiration, CURDATE()) AS MedicalDays
              FROM drivers
              WHERE active = 1
                AND (
                  (cdl_expiration IS NOT NULL AND cdl_expiration <= DATE_ADD(CURDATE(), INTERVAL 60 DAY))
                  OR
                  (medical_card_expiration IS NOT NULL AND medical_card_expiration <= DATE_ADD(CURDATE(), INTERVAL 60 DAY))
                )");

        int inserted = 0;
        foreach (var d in drivers)
        {
            if (d.CdlExpiration.HasValue && d.CdlDays.HasValue)
            {
                var id = await ProcessOneAsync(db, audit, email, emailOpts, d, "cdl_expiring", d.CdlExpiration.Value, d.CdlDays.Value, ct);
                if (id.HasValue) inserted++;
            }
            if (d.MedicalCardExpiration.HasValue && d.MedicalDays.HasValue)
            {
                var id = await ProcessOneAsync(db, audit, email, emailOpts, d, "medical_expiring", d.MedicalCardExpiration.Value, d.MedicalDays.Value, ct);
                if (id.HasValue) inserted++;
            }
        }

        var elapsed = (long)(DateTime.UtcNow - t0).TotalMilliseconds;
        _log.LogInformation("ExpirationAlerts scan: scanned={N} inserted={I} elapsed_ms={Ms}",
            drivers.Count, inserted, elapsed);
        return new RunResult { Scanned = drivers.Count, Inserted = inserted, ElapsedMs = elapsed };
    }

    private async Task<long?> ProcessOneAsync(
        IDbAccess db, IAuditService audit, IEmailService email, BotDotOptions opts,
        DriverExpRow driver, string kind, DateTime expiration, int days, CancellationToken ct)
    {
        var bucket = BucketFor(days);
        if (!bucket.HasValue) return null;

        var urgency = UrgencyForThreshold(bucket.Value);
        var isExpired = bucket.Value < 0 || bucket.Value == 0;
        var finalKind = isExpired
            ? (kind == "cdl_expiring" ? "cdl_expired" : "medical_expired")
            : kind;

        var fieldLabel = kind == "cdl_expiring" ? "CDL" : "Medical Card";
        var dayLabel = days < 0 ? $"vencido hace {Math.Abs(days)} dias"
                     : days == 0 ? "vence HOY"
                     : days == 1 ? "vence manana"
                     : $"vence en {days} dias";

        var title = $"{fieldLabel} de {driver.FullName}: {dayLabel}";
        var body =
            $"Driver: {driver.FullName} (id={driver.Id}, samsara_id={driver.SamsaraId ?? "sin samsara_id"})\n" +
            $"Campo: {fieldLabel}\n" +
            $"Fecha de expiracion: {expiration:yyyy-MM-dd}\n" +
            $"Dias restantes: {days}\n" +
            $"Urgencia: {urgency}\n" +
            $"Threshold cruzado: {bucket.Value}d\n\n" +
            $"Resolver / dismiss en: {opts.PublicUrl}/notifications.html";

        long? insertedId;
        try
        {
            insertedId = await db.ExecuteInsertAsync(
                @"INSERT INTO notifications
                    (kind, subject_type, subject_id, threshold, urgency, title, body)
                  VALUES (@Kind, 'driver', @Sid, @Th, @Urg, @Title, @Body)",
                new { Kind = finalKind, Sid = driver.Id, Th = bucket.Value, Urg = urgency, Title = title, Body = body });
        }
        catch (MySqlException ex) when (ex.ErrorCode == MySqlErrorCode.DuplicateKeyEntry)
        {
            return null;  // ya notificado en este bucket
        }

        // Audit + email son best-effort
        try
        {
            await audit.AppendAsync(new AuditEntry
            {
                UserId = 1,   // admin#1 como sistema (el job no tiene user)
                ActionType = "notification_emitted",
                SubjectType = "driver",
                SubjectId = driver.Id.ToString(),
                Decision = "informational",
                Reasoning = title,
                Evidence = new Dictionary<string, object?>
                {
                    ["kind"] = finalKind, ["threshold"] = bucket.Value, ["urgency"] = urgency,
                    ["expiration"] = expiration.ToString("yyyy-MM-dd"), ["days"] = days,
                },
            }, ct);
        }
        catch (Exception ex) { _log.LogError(ex, "audit append fallo"); }

        if (urgency == "critical" || urgency == "high")
        {
            try
            {
                var to = await GetRecipientsAsync(db, opts);
                if (to.Count > 0)
                {
                    var subjectPrefix = urgency == "critical" ? "[CRITICAL]" : "[HIGH]";
                    var subject = $"{subjectPrefix} BOTDOT — {title}";
                    var result = await email.SendAsync(new EmailMessage { To = to, Subject = subject, Text = body }, ct);
                    await db.ExecuteAsync(
                        @"UPDATE notifications
                          SET email_sent_at = @Sent, email_recipients = @Rec, email_error = @Err
                          WHERE id = @Id",
                        new
                        {
                            Sent = result.Sent ? (DateTime?)DateTime.UtcNow : null,
                            Rec = string.Join(",", to),
                            Err = result.Sent ? null : (result.Error ?? "unknown"),
                            Id = insertedId,
                        });
                }
            }
            catch (Exception ex) { _log.LogError(ex, "email send fallo"); }
        }

        return insertedId;
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

    public static int? BucketFor(int days)
    {
        if (days < 0) return -1;
        if (days == 0) return 0;
        if (days <= 7) return 7;
        if (days <= 14) return 14;
        if (days <= 30) return 30;
        if (days <= 60) return 60;
        return null;
    }

    public static string UrgencyForThreshold(int t)
    {
        if (t < 0) return "critical";
        if (t == 0) return "critical";
        if (t <= 7) return "critical";
        if (t <= 14) return "high";
        if (t <= 30) return "medium";
        return "low";
    }

    public class RunResult
    {
        public int Scanned { get; set; }
        public int Inserted { get; set; }
        public long ElapsedMs { get; set; }
    }

    private class DriverExpRow
    {
        public long Id { get; set; }
        public string? SamsaraId { get; set; }
        public string? FullName { get; set; }
        public DateTime? CdlExpiration { get; set; }
        public DateTime? MedicalCardExpiration { get; set; }
        public int? CdlDays { get; set; }
        public int? MedicalDays { get; set; }
    }
}
