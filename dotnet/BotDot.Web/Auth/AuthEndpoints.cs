// Endpoints de /api/auth/*. Equivalente al src/routes/auth.js del Node.
//
//   POST /api/auth/login            — anonimo, rate limit IP, lockout per-account
//   POST /api/auth/logout           — anonimo, clear cookie
//   GET  /api/auth/me               — auth, info del user actual
//   POST /api/auth/change-password  — auth, rate limit per-user
//
// bcrypt cost: 12 (matchea L1 fix del audit del Node).

using System.Threading.RateLimiting;
using BotDot.Web.Audit;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using BCrypt.Net;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Auth;

public static class AuthEndpoints
{
    /// <summary>
    /// Despues de N intentos fallidos consecutivos sobre la misma cuenta,
    /// la bloqueamos. Solo un admin puede desbloquearla.
    /// </summary>
    public const int MaxFailedLogins = 10;

    /// <summary>
    /// bcrypt cost para nuevos hashes. ~250ms en hardware moderno (2026).
    /// Hashes existentes con cost 10 siguen validando — bcrypt.Verify es
    /// agnostico al cost.
    /// </summary>
    public const int BcryptCost = 12;

    /// <summary>
    /// Min length para nueva password (sea self-service o admin reset).
    /// </summary>
    public const int MinPasswordLength = 8;

    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth");

        group.MapPost("/login", LoginAsync).RequireRateLimiting("login-ip");
        group.MapPost("/logout", Logout);
        group.MapGet("/me", MeAsync).AddEndpointFilter(new RequireAuthFilter());
        group.MapPost("/change-password", ChangePasswordAsync)
             .AddEndpointFilter(new RequireAuthFilter())
             .RequireRateLimiting("change-pwd-user");
    }

    // ─── POST /login ─────────────────────────────────────────────

    private static async Task<IResult> LoginAsync(
        LoginRequest req,
        HttpContext ctx,
        IDbAccess db,
        IJwtService jwt,
        IAuditService audit,
        IOptions<BotDotOptions> opts,
        ILogger<Program> log)
    {
        if (string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrWhiteSpace(req.Password))
            return Results.Json(new { error = "Email y password requeridos" }, statusCode: 400);

        var emailNorm = req.Email.Trim().ToLowerInvariant();

        var user = await db.QueryOneAsync<UserRow>(
            @"SELECT id AS Id, email AS Email, full_name AS FullName, password_hash AS PasswordHash,
                     role AS Role, active AS Active, failed_login_count AS FailedLoginCount,
                     locked_at AS LockedAt, must_change_password AS MustChangePassword
              FROM users WHERE email = @Email",
            new { Email = emailNorm });

        // User no existe → mismo mensaje que password mal (no leak de cuentas).
        if (user == null)
            return Results.Json(new { error = "Credenciales invalidas" }, statusCode: 401);

        if (user.LockedAt.HasValue)
        {
            return Results.Json(new
            {
                error = "Cuenta bloqueada por intentos fallidos. Contacta al administrador para desbloquearla."
            }, statusCode: 423);
        }
        if (!user.Active)
            return Results.Json(new { error = "Credenciales invalidas" }, statusCode: 401);

        var ok = SafeVerifyPassword(req.Password, user.PasswordHash);
        if (!ok)
        {
            var newCount = user.FailedLoginCount + 1;
            var willLock = newCount >= MaxFailedLogins;
            await db.ExecuteAsync(
                $@"UPDATE users SET
                     failed_login_count = @Count,
                     last_failed_login_at = CURRENT_TIMESTAMP,
                     locked_at = {(willLock ? "CURRENT_TIMESTAMP" : "locked_at")}
                   WHERE id = @Id",
                new { Count = newCount, Id = user.Id });

            if (willLock)
            {
                // Audit: la cuenta se bloqueo. CRITICAL log si falla appendAudit.
                try
                {
                    await audit.AppendAsync(new AuditEntry
                    {
                        UserId = user.Id,
                        ActionType = "account_locked",
                        SubjectType = "user",
                        SubjectId = user.Id.ToString(),
                        Decision = "informational",
                        Reasoning = $"Cuenta {user.Email} bloqueada tras {MaxFailedLogins} intentos fallidos consecutivos",
                        Evidence = new Dictionary<string, object?>
                        {
                            ["trigger"] = "failed_login_threshold",
                            ["threshold"] = MaxFailedLogins,
                            ["ip"] = ctx.Connection.RemoteIpAddress?.ToString()
                        }
                    });
                }
                catch (Exception auditErr)
                {
                    log.LogCritical(auditErr,
                        "audit_chain_failure context=account_locked user_id={UserId} email={Email} — investigar inmediatamente",
                        user.Id, user.Email);
                    Console.Error.WriteLine($"[CRITICAL audit] {DateTime.UtcNow:O} account_locked audit failed for user_id={user.Id}: {auditErr.Message}");
                }

                return Results.Json(new
                {
                    error = $"Cuenta bloqueada tras {MaxFailedLogins} intentos fallidos. Contacta al administrador."
                }, statusCode: 423);
            }
            return Results.Json(new { error = "Credenciales invalidas" }, statusCode: 401);
        }

        // Login OK — reset el counter
        await db.ExecuteAsync(
            @"UPDATE users SET
                failed_login_count = 0,
                last_failed_login_at = NULL,
                last_login_at = CURRENT_TIMESTAMP
              WHERE id = @Id",
            new { Id = user.Id });

        var token = jwt.SignToken(user);
        ctx.Response.Cookies.Append(AuthCookieDefaults.Name, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = opts.Value.IsProduction,
            SameSite = SameSiteMode.Strict,
            MaxAge = TimeSpan.FromHours(AuthCookieDefaults.MaxAgeHours),
        });

        return Results.Json(new
        {
            user = new
            {
                id = user.Id,
                email = user.Email,
                name = user.FullName,
                role = user.Role
            },
            mustChangePassword = user.MustChangePassword
        });
    }

    // ─── POST /logout ────────────────────────────────────────────

    private static IResult Logout(HttpContext ctx)
    {
        ctx.Response.Cookies.Delete(AuthCookieDefaults.Name);
        return Results.Json(new { ok = true });
    }

    // ─── GET /me ─────────────────────────────────────────────────

    private static async Task<IResult> MeAsync(HttpContext ctx, IDbAccess db)
    {
        var user = ctx.GetUser()!;
        // must_change_password no esta en el JWT — lo leemos de DB.
        var row = await db.QueryOneAsync<MustChangeRow>(
            @"SELECT must_change_password AS MustChangePassword FROM users WHERE id = @Id",
            new { Id = user.Id });

        return Results.Json(new
        {
            user = new
            {
                id = user.Id,
                email = user.Email,
                role = user.Role,
                name = user.Name,
                mustChangePassword = row?.MustChangePassword == true
            }
        });
    }

    private class MustChangeRow { public bool MustChangePassword { get; set; } }

    // ─── POST /change-password ───────────────────────────────────

    private static async Task<IResult> ChangePasswordAsync(
        ChangePasswordRequest req,
        HttpContext ctx,
        IDbAccess db,
        IAuditService audit,
        ILogger<Program> log)
    {
        var user = ctx.GetUser()!;

        if (string.IsNullOrEmpty(req.CurrentPassword) || string.IsNullOrEmpty(req.NewPassword))
            return Results.Json(new { error = "current_password y new_password requeridos" }, statusCode: 400);

        if (req.NewPassword.Length < MinPasswordLength)
            return Results.Json(new { error = $"La nueva password debe tener al menos {MinPasswordLength} caracteres" }, statusCode: 400);

        if (req.CurrentPassword == req.NewPassword)
            return Results.Json(new { error = "La nueva password debe ser distinta a la actual" }, statusCode: 400);

        var row = await db.QueryOneAsync<UserRow>(
            @"SELECT id AS Id, email AS Email, password_hash AS PasswordHash
              FROM users WHERE id = @Id",
            new { Id = user.Id });

        if (row == null)
            return Results.Json(new { error = "Sesion invalida" }, statusCode: 401);

        if (!SafeVerifyPassword(req.CurrentPassword, row.PasswordHash))
            return Results.Json(new { error = "Password actual incorrecta" }, statusCode: 401);

        var newHash = BCrypt.Net.BCrypt.HashPassword(req.NewPassword, BcryptCost);
        await db.ExecuteAsync(
            @"UPDATE users SET password_hash = @Hash, must_change_password = 0 WHERE id = @Id",
            new { Hash = newHash, Id = row.Id });

        try
        {
            await audit.AppendAsync(new AuditEntry
            {
                UserId = row.Id,
                ActionType = "password_changed_by_user",
                SubjectType = "user",
                SubjectId = row.Id.ToString(),
                Decision = "informational",
                Reasoning = $"{row.Email} cambio su password (self-service)",
                Evidence = new { }
            });
        }
        catch (Exception auditErr)
        {
            log.LogError(auditErr, "audit append failed para password_changed_by_user user_id={UserId}", row.Id);
        }

        return Results.Json(new { ok = true });
    }

    // ─── helpers ──────────────────────────────────────────────────

    /// <summary>
    /// bcrypt.Verify con catch — si el hash en DB esta corrupto o no es bcrypt
    /// valido, devolvemos false en vez de tirar.
    /// </summary>
    private static bool SafeVerifyPassword(string password, string hash)
    {
        if (string.IsNullOrEmpty(hash)) return false;
        try { return BCrypt.Net.BCrypt.Verify(password, hash); }
        catch (SaltParseException) { return false; }
        catch (Exception) { return false; }
    }
}

// ─── Rate limiting policies ──────────────────────────────────────

public static class AuthRateLimits
{
    public static void AddAuthRateLimits(this IServiceCollection services)
    {
        services.AddRateLimiter(o =>
        {
            // login: 30 requests / 15 min por IP. Capa secundaria al lockout
            // por-cuenta (que es la defensa primaria).
            o.AddPolicy("login-ip", ctx => RateLimitPartition.GetFixedWindowLimiter(
                partitionKey: ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                factory: _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 30,
                    Window = TimeSpan.FromMinutes(15),
                    QueueLimit = 0,
                }));

            // change-password: 10 / 15min per usuario autenticado.
            o.AddPolicy("change-pwd-user", ctx =>
            {
                var user = ctx.GetUser();
                var key = user != null ? $"u:{user.Id}" : $"ip:{ctx.Connection.RemoteIpAddress}";
                return RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: key,
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 10,
                        Window = TimeSpan.FromMinutes(15),
                        QueueLimit = 0,
                    });
            });

            // chat send: 30/min per usuario autenticado. Para Fase 5.
            o.AddPolicy("chat-send-user", ctx =>
            {
                var user = ctx.GetUser();
                var key = user != null ? $"u:{user.Id}" : $"ip:{ctx.Connection.RemoteIpAddress}";
                return RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: key,
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 30,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                    });
            });

            o.OnRejected = async (ctx, ct) =>
            {
                ctx.HttpContext.Response.StatusCode = 429;
                ctx.HttpContext.Response.ContentType = "application/json";
                await ctx.HttpContext.Response.WriteAsync(
                    "{\"error\":\"Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.\"}",
                    ct);
            };
        });
    }
}
