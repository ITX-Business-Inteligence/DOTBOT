// Modelos compartidos del layer de auth. Los DTOs de request/response
// usan camelCase via la config global de System.Text.Json.

namespace BotDot.Web.Auth;

public record LoginRequest(string? Email, string? Password);
public record LoginResponse(LoginUserDto User, bool MustChangePassword);
public record LoginUserDto(long Id, string Email, string Name, string Role);

public record MeResponse(MeUserDto User);
public record MeUserDto(long Id, string Email, string Role, string Name, bool MustChangePassword);

public record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);

/// <summary>
/// Usuario autenticado en el contexto de la request. Disponible via
/// HttpContext.Items["User"] o el helper <see cref="HttpContextExtensions.GetUser"/>.
/// </summary>
public record AuthUser(long Id, string Email, string Role, string Name);

/// <summary>
/// Roles validos. Mantener en sync con la columna users.role del schema.
/// </summary>
public static class Roles
{
    public const string Dispatcher = "dispatcher";
    public const string Supervisor = "supervisor";
    public const string Compliance = "compliance";
    public const string Manager = "manager";
    public const string Admin = "admin";

    public static readonly HashSet<string> All = new()
    {
        Dispatcher, Supervisor, Compliance, Manager, Admin
    };
}

/// <summary>
/// Fila de la tabla `users` mapeada por Dapper (snake_case en DB → PascalCase con
/// alias en el SELECT). Usamos un POCO simple para que Dapper lo materialice.
/// </summary>
public class UserRow
{
    public long Id { get; set; }
    public string Email { get; set; } = "";
    public string FullName { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string Role { get; set; } = "";
    public bool Active { get; set; }
    public int FailedLoginCount { get; set; }
    public DateTime? LockedAt { get; set; }
    public bool MustChangePassword { get; set; }
}
