// BOTDOT — entry del server ASP.NET Core 8.
// Equivalente al server.js del Node:
//   - Logger estructurado (Serilog)
//   - Configuracion tipada (IOptions<BotDotOptions>)
//   - Pool MySQL (Dapper)
//   - Health endpoint
//   - Graceful shutdown via IHostApplicationLifetime

using BotDot.Web.Agent;
using BotDot.Web.Agent.Tools;
using BotDot.Web.Audit;
using BotDot.Web.Auth;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using BotDot.Web.Email;
using BotDot.Web.Jobs;
using BotDot.Web.Routes;
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

    // Audit chain (Fase 3) — port byte-exact del src/db/audit-chain.js del Node.
    // Si esto se cambia, hay que correr smoke /api/audit/verify contra la cadena
    // existente para confirmar intact:true.
    builder.Services.AddSingleton<IAuditService, AuditService>();
    builder.Services.AddSingleton<AuditVerifier>();

    // Rate limiting (login + change-password + chat-send)
    builder.Services.AddAuthRateLimits();

    // HttpClient factory para clientes externos (Anthropic real, eCFR, etc).
    builder.Services.AddHttpClient();

    // Agent — Fase 4
    var anthropicMock = builder.Configuration.GetValue<bool>("BotDot:Anthropic:Mock");
    var samsaraMock = builder.Configuration.GetValue<bool>("BotDot:Samsara:Mock");
    var emailMock = builder.Configuration.GetValue<bool>("BotDot:Email:Mock");
    if (anthropicMock)
    {
        Log.Warning("[BOTDOT] MOCK LLM ACTIVO — las respuestas son simuladas, no llaman a Claude real.");
        builder.Services.AddSingleton<IAnthropicClient, MockClaudeClient>();
    }
    else
    {
        builder.Services.AddSingleton<IAnthropicClient, AnthropicHttpClient>();
    }
    if (samsaraMock)
    {
        Log.Warning("[BOTDOT] MOCK SAMSARA ACTIVO — drivers/vehicles/hos vienen de fixtures.");
        builder.Services.AddSingleton<ISamsaraClient, SamsaraMockClient>();
    }
    else
    {
        builder.Services.AddSingleton<ISamsaraClient, SamsaraHttpClient>();
    }
    if (emailMock)
    {
        builder.Services.AddSingleton<IEmailService, MockEmailService>();
    }
    else
    {
        builder.Services.AddSingleton<IEmailService, MailKitEmailService>();
    }
    ToolRegistry.RegisterTools(builder.Services);
    builder.Services.AddSingleton<ChatService>();
    builder.Services.AddSingleton<IInflightGate, InMemoryInflightGate>();
    builder.Services.AddSingleton<BudgetService>();
    builder.Services.AddSingleton<DriverImporter>();

    // Jobs background — Fase 7. Singletons para que /admin/sync/run y
    // /admin/cfr/run y /notifications/run-job puedan invocar metodos
    // ad-hoc fuera del schedule del background service.
    builder.Services.AddSingleton<SamsaraSyncRunner>();
    builder.Services.AddSingleton<SamsaraSyncService>();
    builder.Services.AddSingleton<ExpirationAlertsService>();
    builder.Services.AddSingleton<CfrFetcher>();
    builder.Services.AddSingleton<CfrUpdateService>();
    // Registrar como IHostedService leyendo del singleton — asi tenemos
    // una sola instancia que: corre el cron Y atiende invocaciones ad-hoc.
    builder.Services.AddHostedService(sp => sp.GetRequiredService<SamsaraSyncService>());
    builder.Services.AddHostedService(sp => sp.GetRequiredService<ExpirationAlertsService>());
    builder.Services.AddHostedService(sp => sp.GetRequiredService<CfrUpdateService>());

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

    // Blazor Server — Razor Components con interactividad SignalR.
    // Reemplaza el frontend HTML+JS estatico (que aun queda en wwwroot/ para
    // las paginas no migradas; conforme se migran, se borran las HTML).
    builder.Services.AddRazorComponents()
        .AddInteractiveServerComponents();

    // Antiforgery — requerido por Blazor para forms con InteractiveServer.
    builder.Services.AddAntiforgery();

    // HttpClient para que los componentes Blazor llamen al propio /api/.
    // Sirve para reusar los endpoints que ya estan probados (/api/auth/login, etc).
    builder.Services.AddHttpClient("self", (sp, c) =>
    {
        // BaseAddress se setea por componente desde NavigationManager.BaseUri
        // en runtime — aqui solo configuramos cookies handler.
    });

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
    app.MapAuditEndpoints();
    if (app.Environment.IsDevelopment())
    {
        // Endpoints debug — SOLO en dev. Usados por scripts/verify-cross-stack-audit.js
        app.MapAuditDebugEndpoints();
    }
    app.MapChatEndpoints();
    app.MapDashboardEndpoints();
    app.MapAdminUsersEndpoints();
    app.MapAdminDriversEndpoints();
    app.MapAdminSyncCfrEndpoints();
    app.MapEscalationsEndpoints();
    app.MapNotificationsEndpoints();
    app.MapAnalyticsEndpoints();

    // Static files (wwwroot/) — sirve CSS, JS, imagenes, sw.js, manifest, y
    // las HTML estaticas todavia no migradas a Blazor (app.html, drivers.html,
    // etc). NO usamos UseDefaultFiles porque "/" lo toma Blazor (Login.razor).
    app.UseStaticFiles();

    // Antiforgery — requerido por Blazor con InteractiveServer. Va despues de
    // auth y antes del Map de razor components.
    app.UseAntiforgery();

    // 404 JSON para /api/* desconocidos (antes del SPA fallback).
    app.Map("/api/{**rest}", (HttpContext c) =>
        Results.Json(new { error = $"Endpoint no encontrado: {c.Request.Method} {c.Request.Path}" }, statusCode: 404));

    // Blazor — Razor Components con SignalR interactive server.
    // Maneja "/" (Login) y las paginas migradas. Las paginas no migradas
    // todavia se sirven via UseStaticFiles arriba.
    app.MapRazorComponents<BotDot.Web.Components.App>()
        .AddInteractiveServerRenderMode();

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
