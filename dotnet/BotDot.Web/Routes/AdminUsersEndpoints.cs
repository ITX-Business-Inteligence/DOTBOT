// Endpoints /api/admin/users/* — admin only.
// Equivalente a la seccion de users en src/routes/admin.js Node.

using System.Security.Cryptography;
using System.Text.Json;
using BotDot.Web.Audit;
using BotDot.Web.Auth;
using BotDot.Web.Data;
using MySqlConnector;

namespace BotDot.Web.Routes;

public static class AdminUsersEndpoints
{
    private static readonly string[] ValidRoles = new[]
    {
        Roles.Dispatcher, Roles.Supervisor, Roles.Compliance, Roles.Manager, Roles.Admin
    };
    private const int MinPasswordLen = 8;
    private const int BcryptCost = 12;
    private static readonly System.Text.RegularExpressions.Regex EmailRe =
        new(@"^[^\s@]+@[^\s@]+\.[^\s@]+$");

    public static void MapAdminUsersEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/admin/users")
            .AddEndpointFilter(new RequireAuthFilter(Roles.Admin));

        grp.MapGet("/", ListAsync);
        grp.MapPost("/", CreateAsync);
        grp.MapPatch("/{id:long}", UpdateAsync);
        grp.MapPost("/{id:long}/reset-password", ResetPasswordAsync);
        grp.MapPost("/{id:long}/unlock", UnlockAsync);
        grp.MapDelete("/{id:long}", DeleteForbidden);
    }

    private static async Task<IResult> ListAsync(IDbAccess db)
    {
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT id, email, full_name, role, active, last_login_at, created_at,
                     locked_at, failed_login_count, must_change_password
              FROM users
              ORDER BY active DESC, role ASC, full_name ASC");
        return Results.Json(new { users = rows });
    }

    private record CreateUserReq(string? Email, string? FullName, string? Password, string? Role);

    private static async Task<IResult> CreateAsync(CreateUserReq req, HttpContext ctx, IDbAccess db, IAuditService audit)
    {
        var actor = ctx.GetUser()!;

        if (string.IsNullOrEmpty(req.Email) || string.IsNullOrEmpty(req.FullName)
            || string.IsNullOrEmpty(req.Password) || string.IsNullOrEmpty(req.Role))
            return Results.Json(new { error = "email, full_name, password y role son requeridos" }, statusCode: 400);
        if (!EmailRe.IsMatch(req.Email))
            return Results.Json(new { error = "email invalido" }, statusCode: 400);
        if (!ValidRoles.Contains(req.Role))
            return Results.Json(new { error = $"role invalido. Validos: {string.Join(", ", ValidRoles)}" }, statusCode: 400);
        if (req.Password.Length < MinPasswordLen)
            return Results.Json(new { error = $"password debe tener al menos {MinPasswordLen} caracteres" }, statusCode: 400);

        var hash = BCrypt.Net.BCrypt.HashPassword(req.Password, BcryptCost);
        long newId;
        try
        {
            newId = await db.ExecuteInsertAsync(
                @"INSERT INTO users (email, full_name, password_hash, role, active)
                  VALUES (@Email, @FullName, @Hash, @Role, 1)",
                new { req.Email, req.FullName, Hash = hash, req.Role });
        }
        catch (MySqlException ex) when (ex.ErrorCode == MySqlErrorCode.DuplicateKeyEntry)
        {
            return Results.Json(new { error = $"Ya existe un usuario con email {req.Email}" }, statusCode: 409);
        }

        await audit.AppendAsync(new AuditEntry
        {
            UserId = actor.Id,
            ActionType = "user_management",
            SubjectType = "user",
            SubjectId = newId.ToString(),
            Decision = "informational",
            Reasoning = $"Admin {actor.Email} creo usuario {req.Email} con rol {req.Role}",
            Evidence = new Dictionary<string, object?>
            {
                ["action"] = "create",
                ["email"] = req.Email,
                ["full_name"] = req.FullName,
                ["role"] = req.Role,
            },
        });

        var created = await db.QueryOneAsync<dynamic>(
            "SELECT id, email, full_name, role, active, last_login_at, created_at FROM users WHERE id = @Id",
            new { Id = newId });
        return Results.Json(new { user = created }, statusCode: 201);
    }

    private record UpdateUserReq(string? FullName, string? Email, string? Role, bool? Active);

    private static async Task<IResult> UpdateAsync(long id, UpdateUserReq req, HttpContext ctx, IDbAccess db, IAuditService audit)
    {
        var actor = ctx.GetUser()!;

        var target = await db.QueryOneAsync<TargetUser>(
            "SELECT id AS Id, email AS Email, role AS Role, active AS Active FROM users WHERE id = @Id",
            new { Id = id });
        if (target == null) return Results.Json(new { error = "Usuario no encontrado" }, statusCode: 404);

        // Self-protection
        if (id == actor.Id)
        {
            if (req.Role != null && req.Role != target.Role)
                return Results.Json(new { error = "No puedes cambiar tu propio rol. Pide a otro admin." }, statusCode: 400);
            if (req.Active == false)
                return Results.Json(new { error = "No puedes desactivar tu propio usuario." }, statusCode: 400);
        }

        // Last-admin protection
        var willLoseAdmin =
            (req.Role != null && req.Role != Roles.Admin && target.Role == Roles.Admin) ||
            (req.Active == false && target.Role == Roles.Admin && target.Active);
        if (willLoseAdmin)
        {
            var n = await db.QueryScalarAsync<long?>(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1 AND id != @Id",
                new { Id = id });
            if ((n ?? 0) == 0)
                return Results.Json(new { error = "No puedes degradar/desactivar al ultimo admin activo." }, statusCode: 400);
        }

        var sets = new List<string>();
        var args = new Dictionary<string, object?>();
        if (req.FullName != null) { sets.Add("full_name = @FullName"); args["FullName"] = req.FullName; }
        if (req.Email != null)
        {
            if (!EmailRe.IsMatch(req.Email))
                return Results.Json(new { error = "email invalido" }, statusCode: 400);
            sets.Add("email = @Email"); args["Email"] = req.Email;
        }
        if (req.Role != null)
        {
            if (!ValidRoles.Contains(req.Role))
                return Results.Json(new { error = "role invalido" }, statusCode: 400);
            sets.Add("role = @Role"); args["Role"] = req.Role;
        }
        if (req.Active.HasValue)
        {
            sets.Add("active = @Active"); args["Active"] = req.Active.Value ? 1 : 0;
        }
        if (sets.Count == 0)
            return Results.Json(new { error = "Nada que actualizar" }, statusCode: 400);

        args["Id"] = id;
        try
        {
            await db.ExecuteAsync($"UPDATE users SET {string.Join(", ", sets)} WHERE id = @Id", args);
        }
        catch (MySqlException ex) when (ex.ErrorCode == MySqlErrorCode.DuplicateKeyEntry)
        {
            return Results.Json(new { error = "Ya existe un usuario con ese email" }, statusCode: 409);
        }

        await audit.AppendAsync(new AuditEntry
        {
            UserId = actor.Id,
            ActionType = "user_management",
            SubjectType = "user",
            SubjectId = id.ToString(),
            Decision = "informational",
            Reasoning = $"Admin {actor.Email} edito usuario id={id} ({target.Email})",
            Evidence = new Dictionary<string, object?>
            {
                ["action"] = "update",
                ["changes"] = req,
                ["before"] = new { id = target.Id, email = target.Email, role = target.Role, active = target.Active },
            },
        });

        var updated = await db.QueryOneAsync<dynamic>(
            "SELECT id, email, full_name, role, active, last_login_at, created_at FROM users WHERE id = @Id",
            new { Id = id });
        return Results.Json(new { user = updated });
    }

    private record ResetPasswordReq(string? Password);

    private static async Task<IResult> ResetPasswordAsync(long id, ResetPasswordReq? req, HttpContext ctx, IDbAccess db, IAuditService audit)
    {
        var actor = ctx.GetUser()!;
        var target = await db.QueryOneAsync<TargetUser>(
            "SELECT id AS Id, email AS Email, role AS Role, active AS Active FROM users WHERE id = @Id",
            new { Id = id });
        if (target == null) return Results.Json(new { error = "Usuario no encontrado" }, statusCode: 404);

        string newPassword;
        if (!string.IsNullOrEmpty(req?.Password))
        {
            if (req.Password.Length < MinPasswordLen)
                return Results.Json(new { error = $"password debe tener al menos {MinPasswordLen} caracteres" }, statusCode: 400);
            newPassword = req.Password;
        }
        else
        {
            // Generar password de ~12 chars
            var bytes = RandomNumberGenerator.GetBytes(9);
            newPassword = Convert.ToBase64String(bytes).Replace("+", "").Replace("/", "").Replace("=", "");
            if (newPassword.Length > 11) newPassword = newPassword[..11];
            newPassword += "!";
        }

        var hash = BCrypt.Net.BCrypt.HashPassword(newPassword, BcryptCost);
        await db.ExecuteAsync(
            @"UPDATE users SET
                password_hash = @Hash,
                must_change_password = 1,
                locked_at = NULL,
                failed_login_count = 0
              WHERE id = @Id",
            new { Hash = hash, Id = id });

        await audit.AppendAsync(new AuditEntry
        {
            UserId = actor.Id,
            ActionType = "user_management",
            SubjectType = "user",
            SubjectId = id.ToString(),
            Decision = "informational",
            Reasoning = $"Admin {actor.Email} hizo password reset a usuario id={id} ({target.Email})",
            Evidence = new Dictionary<string, object?>
            {
                ["action"] = "password_reset",
                ["generated"] = string.IsNullOrEmpty(req?.Password),
            },
        });

        return Results.Json(new
        {
            password = newPassword,
            hint = "Compartelo por canal seguro. El usuario debera cambiarla en su proximo login.",
        });
    }

    private static async Task<IResult> UnlockAsync(long id, HttpContext ctx, IDbAccess db, IAuditService audit)
    {
        var actor = ctx.GetUser()!;
        var target = await db.QueryOneAsync<UnlockTargetUser>(
            "SELECT id AS Id, email AS Email, locked_at AS LockedAt FROM users WHERE id = @Id",
            new { Id = id });
        if (target == null) return Results.Json(new { error = "Usuario no encontrado" }, statusCode: 404);
        if (!target.LockedAt.HasValue)
            return Results.Json(new { error = "La cuenta no esta bloqueada" }, statusCode: 400);

        await db.ExecuteAsync(
            "UPDATE users SET locked_at = NULL, failed_login_count = 0 WHERE id = @Id",
            new { Id = id });

        await audit.AppendAsync(new AuditEntry
        {
            UserId = actor.Id,
            ActionType = "user_management",
            SubjectType = "user",
            SubjectId = id.ToString(),
            Decision = "informational",
            Reasoning = $"Admin {actor.Email} desbloqueo cuenta de {target.Email}",
            Evidence = new Dictionary<string, object?>
            {
                ["action"] = "unlock",
                ["was_locked_at"] = target.LockedAt,
            },
        });

        return Results.Json(new { unlocked = true });
    }

    private static IResult DeleteForbidden(long id) =>
        Results.Json(new
        {
            error = "Borrado fisico no permitido. Usa PATCH con active=false para desactivar el usuario."
        }, statusCode: 405);

    private class TargetUser
    {
        public long Id { get; set; }
        public string Email { get; set; } = "";
        public string Role { get; set; } = "";
        public bool Active { get; set; }
    }

    private class UnlockTargetUser
    {
        public long Id { get; set; }
        public string Email { get; set; } = "";
        public DateTime? LockedAt { get; set; }
    }
}
