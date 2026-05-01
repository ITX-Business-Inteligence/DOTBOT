// Budget caps de Claude API.
// Equivalente al src/utils/budget.js del Node.
//
// Dos defensas:
//   - Cap por usuario / dia (24h rolling)
//   - Cap global (org) / dia
//
// Race condition aceptada: tokens se contabilizan al recibir respuesta,
// asi que con N requests concurrentes podria sobrepasarse por margen
// pequeno. MVP single-process aceptable.

using BotDot.Web.Configuration;
using BotDot.Web.Data;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Agent;

public class BudgetCheckResult
{
    public bool Allowed { get; set; }
    public string? Scope { get; set; }   // "user" | "org" | null
    public decimal UserSpentUsd { get; set; }
    public decimal UserCapUsd { get; set; }
    public decimal OrgSpentUsd { get; set; }
    public decimal OrgCapUsd { get; set; }
}

public class BudgetService
{
    private readonly IDbAccess _db;
    private readonly ChatOptions _opts;
    private readonly string _model;

    public BudgetService(IDbAccess db, IOptions<BotDotOptions> opts)
    {
        _db = db;
        _opts = opts.Value.Chat;
        _model = opts.Value.Anthropic.Model;
    }

    public async Task<BudgetCheckResult> CheckAsync(long userId)
    {
        var userCap = _opts.UserDailyBudgetUsd;
        var orgCap = _opts.OrgDailyBudgetUsd;

        var userSpentTask = SpendUsdAsync(userId, hours: 24);
        var orgSpentTask = SpendUsdAsync(null, hours: 24);
        await Task.WhenAll(userSpentTask, orgSpentTask);

        var userSpent = await userSpentTask;
        var orgSpent = await orgSpentTask;

        var userOver = userCap > 0 && userSpent >= userCap;
        var orgOver = orgCap > 0 && orgSpent >= orgCap;

        var result = new BudgetCheckResult
        {
            UserSpentUsd = Math.Round(userSpent, 2),
            UserCapUsd = userCap,
            OrgSpentUsd = Math.Round(orgSpent, 2),
            OrgCapUsd = orgCap,
            Allowed = !(userOver || orgOver),
        };
        if (orgOver) result.Scope = "org";
        else if (userOver) result.Scope = "user";
        return result;
    }

    /// <summary>
    /// Pricing tabla — debe matchear el src/utils/pricing.js del Node.
    /// USD por 1M tokens.
    /// </summary>
    private static readonly Dictionary<string, (decimal input, decimal output, decimal cacheRead, decimal cacheWrite)> Pricing
        = new()
        {
            ["claude-sonnet-4-6"] = (3m,  15m, 0.30m, 3.75m),
            ["claude-opus-4-7"]   = (15m, 75m, 1.50m, 18.75m),
            ["claude-haiku-4-5"]  = (1m,  5m,  0.10m, 1.25m),
        };

    private async Task<decimal> SpendUsdAsync(long? userId, int hours)
    {
        var p = Pricing.TryGetValue(_model, out var x) ? x : Pricing["claude-sonnet-4-6"];

        string sql;
        object args;
        if (userId.HasValue)
        {
            sql = @"SELECT
                      COALESCE(SUM(m.tokens_input), 0)        AS TokensInput,
                      COALESCE(SUM(m.tokens_output), 0)       AS TokensOutput,
                      COALESCE(SUM(m.tokens_cache_read), 0)   AS TokensCacheRead,
                      COALESCE(SUM(m.tokens_cache_create), 0) AS TokensCacheCreate
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.created_at >= DATE_SUB(NOW(), INTERVAL @Hours HOUR)
                      AND c.user_id = @UserId";
            args = new { Hours = hours, UserId = userId.Value };
        }
        else
        {
            sql = @"SELECT
                      COALESCE(SUM(m.tokens_input), 0)        AS TokensInput,
                      COALESCE(SUM(m.tokens_output), 0)       AS TokensOutput,
                      COALESCE(SUM(m.tokens_cache_read), 0)   AS TokensCacheRead,
                      COALESCE(SUM(m.tokens_cache_create), 0) AS TokensCacheCreate
                    FROM messages m
                    WHERE m.created_at >= DATE_SUB(NOW(), INTERVAL @Hours HOUR)";
            args = new { Hours = hours };
        }

        var row = await _db.QueryOneAsync<TokenSums>(sql, args);
        if (row == null) return 0m;

        return (row.TokensInput / 1_000_000m) * p.input
             + (row.TokensOutput / 1_000_000m) * p.output
             + (row.TokensCacheRead / 1_000_000m) * p.cacheRead
             + (row.TokensCacheCreate / 1_000_000m) * p.cacheWrite;
    }

    private class TokenSums
    {
        public long TokensInput { get; set; }
        public long TokensOutput { get; set; }
        public long TokensCacheRead { get; set; }
        public long TokensCacheCreate { get; set; }
    }
}
