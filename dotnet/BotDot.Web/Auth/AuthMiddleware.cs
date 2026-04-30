// Middleware de auth — lee cookie botdot_token, valida JWT, setea
// HttpContext.Items["User"] con el AuthUser.
//
// Equivalente al authMiddleware de src/middleware/auth.js del Node.
//
// IMPORTANTE: NO acepta Bearer header (cookie-only — matchea L5 fix del audit).

using System.Diagnostics.CodeAnalysis;
using BotDot.Web.Auth;
using Serilog.Context;

namespace BotDot.Web.Auth;

public static class AuthCookieDefaults
{
    public const string Name = "botdot_token";
    public const int MaxAgeHours = 8;
}

public class AuthMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IJwtService _jwt;

    public AuthMiddleware(RequestDelegate next, IJwtService jwt)
    {
        _next = next;
        _jwt = jwt;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        // Best-effort: intentamos decodificar la cookie. Si esta presente y
        // valida, populamos HttpContext.Items["User"]. Si no esta o es invalida,
        // dejamos pasar — los endpoints que requieren auth chequean despues.
        if (ctx.Request.Cookies.TryGetValue(AuthCookieDefaults.Name, out var token))
        {
            var user = _jwt.ValidateToken(token);
            if (user != null)
            {
                ctx.Items["User"] = user;
                // Enriquecer Serilog scope: cada log line del request lleva user_id + role
                using (LogContext.PushProperty("UserId", user.Id))
                using (LogContext.PushProperty("UserRole", user.Role))
                {
                    await _next(ctx);
                    return;
                }
            }
        }
        await _next(ctx);
    }
}

/// <summary>
/// Helpers de extension sobre HttpContext para leer el AuthUser actual.
/// </summary>
public static class HttpContextAuthExtensions
{
    public static AuthUser? GetUser(this HttpContext ctx)
        => ctx.Items["User"] as AuthUser;

    public static bool TryGetUser(this HttpContext ctx, [NotNullWhen(true)] out AuthUser? user)
    {
        user = ctx.Items["User"] as AuthUser;
        return user != null;
    }

    /// <summary>
    /// Helper para escribir 401 JSON estandar. Uso en endpoint groups.
    /// </summary>
    public static IResult Unauthorized()
        => Results.Json(new { error = "No autenticado" }, statusCode: 401);

    public static IResult Forbidden()
        => Results.Json(new { error = "No autorizado para este recurso" }, statusCode: 403);
}

/// <summary>
/// Endpoint filter que requiere auth + opcionalmente uno o mas roles.
/// Uso en endpoint groups:
///   group.AddEndpointFilter(new RequireAuthFilter(Roles.Admin, Roles.Compliance))
/// </summary>
public class RequireAuthFilter : IEndpointFilter
{
    private readonly HashSet<string>? _allowedRoles;

    public RequireAuthFilter(params string[] allowedRoles)
    {
        _allowedRoles = allowedRoles.Length == 0 ? null : new HashSet<string>(allowedRoles);
    }

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var user = ctx.HttpContext.GetUser();
        if (user == null) return HttpContextAuthExtensions.Unauthorized();
        if (_allowedRoles != null && !_allowedRoles.Contains(user.Role))
            return HttpContextAuthExtensions.Forbidden();
        return await next(ctx);
    }
}
