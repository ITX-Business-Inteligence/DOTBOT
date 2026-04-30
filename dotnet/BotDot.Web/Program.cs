// BOTDOT — entry del server ASP.NET Core 8.
// Equivalente al server.js del Node:
//   - Logger estructurado (Serilog)
//   - Configuracion tipada (IOptions<BotDotOptions>)
//   - Pool MySQL (Dapper)
//   - Health endpoint
//   - Graceful shutdown via IHostApplicationLifetime

using BotDot.Web.Audit;
using BotDot.Web.Auth;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using Serilog;

// Bootstrap Serilog antes del builder para capturar errores tempranos.
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft.AspNetCore", Serilog.Events.LogEventLevel.Warning)
    .Enrich.FromLogContext()
    .Enrich.WithProperty("Service", "botdot")
    .WriteTo.Console(outputTemplate:
        "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}")
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    // Reemplaza el logger default por Serilog (lee config de appsettings + enrichers).
    builder.Host.UseSerilog((ctx, services, lc) => lc
        .ReadFrom.Configuration(ctx.Configuration)
        .ReadFrom.Services(services)
        .Enrich.FromLogContext()
        .Enrich.WithProperty("Service", "botdot")
        .Enrich.WithProperty("Env", ctx.HostingEnvironment.EnvironmentName)
        .WriteTo.Console(outputTemplate:
            "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}"));

    // Configuracion tipada — toda la app inyecta IOptions<BotDotOptions>.
    builder.Services.Configure<BotDotOptions>(builder.Configuration.GetSection("BotDot"));

    // DB pool (Dapper + MySqlConnector). Singleton porque no tiene estado mutable
    // (el pool real lo maneja MySqlConnector internamente).
    builder.Services.AddSingleton<IDbAccess, DbAccess>();

    // Auth services
    builder.Services.AddSingleton<IJwtService, JwtService>();
    // Audit: Fase 2 usa stub. Fase 3 lo reemplaza con la implementacion real
    // del hash chain.
    builder.Services.AddSingleton<IAuditService, StubAuditService>();

    // Rate limiting (login + change-password + chat-send)
    builder.Services.AddAuthRateLimits();

    // HttpClient factory (lo usaremos en Fase 4 para Anthropic + Samsara + eCFR).
    builder.Services.AddHttpClient();

    // JSON: usar snake_case en wire format (matchea el contrato del Node:
    // current_password, must_change_password, full_name, etc). Dentro de C#
    // las propiedades siguen siendo PascalCase. La policy aplica tanto a
    // serializacion (response) como deserializacion (request body).
    builder.Services.Configure<Microsoft.AspNetCore.Http.Json.JsonOptions>(o =>
    {
        o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower;
        o.SerializerOptions.DictionaryKeyPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower;
    });

    builder.Services.AddRouting();

    var app = builder.Build();

    var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
    var opts = app.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<BotDotOptions>>().Value;

    Log.Information("BOTDOT iniciando — env={Env} mock_llm={MockLlm} mock_samsara={MockSamsara}",
        opts.Env, opts.Anthropic.Mock, opts.Samsara.Mock);

    // Headers de seguridad equivalentes a helmet del Node.
    app.Use(async (ctx, next) =>
    {
        ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
        ctx.Response.Headers["X-Frame-Options"] = "SAMEORIGIN";
        ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
        ctx.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
        ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        if (opts.IsProduction)
        {
            ctx.Response.Headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
        }
        // CSP: scriptSrc SIN unsafe-inline (todo JS en archivos de wwwroot/js).
        ctx.Response.Headers["Content-Security-Policy"] =
            "default-src 'self'; " +
            "script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; " +
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
            "font-src 'self' https://fonts.gstatic.com; " +
            "img-src 'self' data: blob:; " +
            "connect-src 'self'; " +
            "manifest-src 'self'; " +
            "worker-src 'self'; " +
            "object-src 'none'; " +
            "frame-ancestors 'self'; " +
            "base-uri 'self'; " +
            "form-action 'self'";
        await next();
    });

    // Auth middleware: lee cookie botdot_token, popula HttpContext.Items["User"].
    // Endpoints individuales chequean auth con [RequireAuthFilter()].
    app.UseMiddleware<AuthMiddleware>();

    // Rate limiter middleware (las policies se aplican via RequireRateLimiting per-endpoint).
    app.UseRateLimiter();

    // Logger por request — agrega request_id a cada log line.
    app.UseSerilogRequestLogging(o =>
    {
        o.MessageTemplate = "{RequestMethod} {RequestPath} {StatusCode} in {Elapsed:0}ms";
        o.GetLevel = (httpCtx, elapsed, ex) =>
            ex != null || httpCtx.Response.StatusCode >= 500
                ? Serilog.Events.LogEventLevel.Error
                : httpCtx.Response.StatusCode >= 400
                    ? Serilog.Events.LogEventLevel.Warning
                    : Serilog.Events.LogEventLevel.Information;
    });

    // Health endpoint — durante shutdown devuelve 503.
    var isShuttingDown = false;
    lifetime.ApplicationStopping.Register(() => isShuttingDown = true);

    app.MapGet("/api/health", () =>
    {
        if (isShuttingDown)
        {
            return Results.Json(new
            {
                ok = false,
                shutting_down = true,
                ts = DateTime.UtcNow.ToString("O")
            }, statusCode: 503);
        }
        return Results.Json(new
        {
            ok = true,
            env = opts.Env,
            mock_llm = opts.Anthropic.Mock,
            mock_samsara = opts.Samsara.Mock,
            sync_enabled = opts.Sync.Enabled,
            ts = DateTime.UtcNow.ToString("O")
        });
    });

    // ──── API endpoints ────
    app.MapAuthEndpoints();

    // Static files (wwwroot/) — equivalente a express.static('public').
    app.UseDefaultFiles();
    app.UseStaticFiles();

    // 404 JSON para /api/* desconocidos (antes del SPA fallback).
    app.Map("/api/{**rest}", (HttpContext c) =>
        Results.Json(new { error = $"Endpoint no encontrado: {c.Request.Method} {c.Request.Path}" }, statusCode: 404));

    // SPA fallback — cualquier GET no matcheado devuelve index.html.
    app.MapFallbackToFile("index.html");

    // Warning si estamos en prod con mocks activos.
    if (opts.IsProduction && (opts.Anthropic.Mock || opts.Samsara.Mock))
    {
        Log.Warning("[!] MOCK MODE EN PRODUCCION — verifica appsettings: mock_llm={MockLlm} mock_samsara={MockSamsara}",
            opts.Anthropic.Mock, opts.Samsara.Mock);
    }

    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex, "Error fatal al iniciar el servidor");
}
finally
{
    Log.CloseAndFlush();
}
