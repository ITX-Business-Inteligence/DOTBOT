// Helper compartido por los syncs. Cada corrida queda registrada en
// sync_runs (start/finish/duration/status/records). Equivalente a
// src/sync/runner.js Node.

using BotDot.Web.Configuration;
using BotDot.Web.Data;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Jobs;

public class SamsaraSyncRunner
{
    private readonly IDbAccess _db;
    private readonly bool _isMock;
    private readonly ILogger<SamsaraSyncRunner> _log;

    public SamsaraSyncRunner(IDbAccess db, IOptions<BotDotOptions> opts, ILogger<SamsaraSyncRunner> log)
    {
        _db = db;
        _isMock = opts.Value.Samsara.Mock;
        _log = log;
    }

    public class SyncRunResult
    {
        public bool Ok { get; set; }
        public int Records { get; set; }
        public long DurationMs { get; set; }
        public string? Error { get; set; }
    }

    public async Task<SyncRunResult> RunAsync(string resource, Func<Task<int>> work)
    {
        var runId = await _db.ExecuteInsertAsync(
            "INSERT INTO sync_runs (resource, status, source) VALUES (@R, 'running', @S)",
            new { R = resource, S = _isMock ? "mock" : "live" });

        var t0 = DateTime.UtcNow;
        try
        {
            var records = await work();
            var elapsed = (long)(DateTime.UtcNow - t0).TotalMilliseconds;
            await _db.ExecuteAsync(
                @"UPDATE sync_runs
                  SET finished_at = CURRENT_TIMESTAMP(6), status = 'success',
                      records_synced = @N, duration_ms = @Dur
                  WHERE id = @Id",
                new { N = records, Dur = elapsed, Id = runId });
            return new SyncRunResult { Ok = true, Records = records, DurationMs = elapsed };
        }
        catch (Exception ex)
        {
            var elapsed = (long)(DateTime.UtcNow - t0).TotalMilliseconds;
            var msg = ex.Message;
            if (msg.Length > 1000) msg = msg[..1000];
            await _db.ExecuteAsync(
                @"UPDATE sync_runs
                  SET finished_at = CURRENT_TIMESTAMP(6), status = 'error',
                      duration_ms = @Dur, error_message = @Err
                  WHERE id = @Id",
                new { Dur = elapsed, Err = msg, Id = runId });
            _log.LogError(ex, "sync {Resource} failed", resource);
            return new SyncRunResult { Ok = false, Error = ex.Message, DurationMs = elapsed };
        }
    }
}
