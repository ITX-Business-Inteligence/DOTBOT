// Pool MySQL + helpers Query / QueryOne / Transaction.
// Equivalente directo al src/db/pool.js del Node.
//
// Uso (DI):
//   public MyService(IDbAccess db) { _db = db; }
//   var rows = await _db.QueryAsync<UserRow>("SELECT ...", new { id });
//
// Decision: Dapper (no EF Core) — para audit chain compliance necesitamos
// SQL exacto, no queries auto-generadas que pueden cambiar entre versiones
// de EF y romper los hashes deterministicos.

using System.Data;
using BotDot.Web.Configuration;
using Dapper;
using Microsoft.Extensions.Options;
using MySqlConnector;

namespace BotDot.Web.Data;

public interface IDbAccess
{
    Task<IReadOnlyList<T>> QueryAsync<T>(string sql, object? param = null);
    Task<T?> QueryOneAsync<T>(string sql, object? param = null) where T : class;
    Task<T> QueryScalarAsync<T>(string sql, object? param = null);
    Task<int> ExecuteAsync(string sql, object? param = null);
    Task<long> ExecuteInsertAsync(string sql, object? param = null);
    Task<TResult> TransactionAsync<TResult>(Func<MySqlConnection, MySqlTransaction, Task<TResult>> work);
    MySqlConnection GetConnection();
}

public class DbAccess : IDbAccess
{
    private readonly string _connStr;
    private readonly ILogger<DbAccess> _log;

    public DbAccess(IOptions<BotDotOptions> opts, ILogger<DbAccess> log)
    {
        _connStr = opts.Value.Db.ConnectionString;
        _log = log;
    }

    public MySqlConnection GetConnection() => new(_connStr);

    public async Task<IReadOnlyList<T>> QueryAsync<T>(string sql, object? param = null)
    {
        await using var conn = GetConnection();
        var rows = await conn.QueryAsync<T>(sql, param);
        return rows.AsList();
    }

    public async Task<T?> QueryOneAsync<T>(string sql, object? param = null) where T : class
    {
        await using var conn = GetConnection();
        return await conn.QueryFirstOrDefaultAsync<T>(sql, param);
    }

    public async Task<T> QueryScalarAsync<T>(string sql, object? param = null)
    {
        await using var conn = GetConnection();
        return await conn.ExecuteScalarAsync<T>(sql, param) ?? default!;
    }

    public async Task<int> ExecuteAsync(string sql, object? param = null)
    {
        await using var conn = GetConnection();
        return await conn.ExecuteAsync(sql, param);
    }

    public async Task<long> ExecuteInsertAsync(string sql, object? param = null)
    {
        await using var conn = GetConnection();
        await conn.ExecuteAsync(sql, param);
        // mysql2 driver Node devuelve insertId; Dapper no, asi que pedimos LAST_INSERT_ID
        return await conn.ExecuteScalarAsync<long>("SELECT LAST_INSERT_ID()");
    }

    /// <summary>
    /// Ejecuta el callback dentro de una transaccion. Commits si retorna sin tirar,
    /// rollback si tira. Equivalente al transaction() helper del pool.js.
    /// </summary>
    public async Task<TResult> TransactionAsync<TResult>(Func<MySqlConnection, MySqlTransaction, Task<TResult>> work)
    {
        await using var conn = GetConnection();
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        try
        {
            var result = await work(conn, tx);
            await tx.CommitAsync();
            return result;
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }
}
