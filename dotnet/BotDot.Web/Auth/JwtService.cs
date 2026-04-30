// Issuing y validation de JWT. Usa HS256 con el secreto de
// BotDot:Auth:JwtSecret en appsettings (>=64 chars).
//
// Equivalente al src/middleware/auth.js del Node — el formato del payload
// (sub, email, role, name, iat, exp) se mantiene identico para que tanto
// el server Node como el .NET puedan emitir cookies que el otro acepta
// (util durante migracion gradual si fuera necesario, aunque cada server
// tipicamente firma con secreto distinto).

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using BotDot.Web.Configuration;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace BotDot.Web.Auth;

public interface IJwtService
{
    string SignToken(UserRow user);
    AuthUser? ValidateToken(string? token);
}

public class JwtService : IJwtService
{
    private readonly AuthOptions _opts;
    private readonly SymmetricSecurityKey _key;
    private readonly TokenValidationParameters _validationParams;
    private readonly JwtSecurityTokenHandler _handler;

    public JwtService(IOptions<BotDotOptions> opts)
    {
        // Desactivar el claim re-mapping default de Microsoft (sub → NameIdentifier,
        // email → Email, etc). Queremos los nombres "raw" del payload para que
        // el formato matchee 1:1 al del Node (cookie compatible si se comparte secreto).
        _handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        _opts = opts.Value.Auth;
        if (string.IsNullOrEmpty(_opts.JwtSecret) || _opts.JwtSecret.Length < 32)
        {
            throw new InvalidOperationException(
                "BotDot:Auth:JwtSecret debe tener al menos 32 chars. Generar con: openssl rand -hex 64");
        }
        _key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_opts.JwtSecret));
        _validationParams = new TokenValidationParameters
        {
            ValidateIssuer = false,            // Mismo dominio, sin issuer
            ValidateAudience = false,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = _key,
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    }

    public string SignToken(UserRow user)
    {
        var now = DateTime.UtcNow;
        var expires = now.AddHours(_opts.JwtExpiresHours);

        // Claims con los nombres "sub/email/role/name" que matcheen el payload
        // del Node (el cookie firmado por uno puede leerse por el otro si
        // comparten secreto).
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, user.Email),
            new("role", user.Role),
            new("name", user.FullName),
            new(JwtRegisteredClaimNames.Iat, new DateTimeOffset(now).ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
        };

        var creds = new SigningCredentials(_key, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            claims: claims,
            notBefore: now,
            expires: expires,
            signingCredentials: creds);

        return _handler.WriteToken(token);
    }

    public AuthUser? ValidateToken(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        try
        {
            var principal = _handler.ValidateToken(token, _validationParams, out _);
            var sub = principal.FindFirstValue(JwtRegisteredClaimNames.Sub);
            var email = principal.FindFirstValue(JwtRegisteredClaimNames.Email);
            var role = principal.FindFirstValue("role");
            var name = principal.FindFirstValue("name");
            if (sub == null || email == null || role == null || name == null) return null;
            if (!long.TryParse(sub, out var id)) return null;
            return new AuthUser(id, email, role, name);
        }
        catch (SecurityTokenException)
        {
            // Token invalido / expirado / firma mala. NO logueamos como warning
            // porque pasa muchas veces (usuarios con sesion expirada).
            return null;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
