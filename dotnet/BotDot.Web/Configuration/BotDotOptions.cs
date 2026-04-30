// POCOs que mapean appsettings.json a tipos fuertemente tipados.
// Bind via builder.Services.Configure<BotDotOptions>(config.GetSection("BotDot")).
// Equivalente al src/config/index.js del Node.

namespace BotDot.Web.Configuration;

public class BotDotOptions
{
    public string Env { get; set; } = "Development";
    public string PublicUrl { get; set; } = "http://localhost:5050";
    public DbOptions Db { get; set; } = new();
    public AnthropicOptions Anthropic { get; set; } = new();
    public SamsaraOptions Samsara { get; set; } = new();
    public AuthOptions Auth { get; set; } = new();
    public SyncOptions Sync { get; set; } = new();
    public JobsOptions Jobs { get; set; } = new();
    public EmailOptions Email { get; set; } = new();
    public ChatOptions Chat { get; set; } = new();
    public AuditOptions Audit { get; set; } = new();
    public FmcsaOptions Fmcsa { get; set; } = new();

    public bool IsProduction => Env.Equals("Production", StringComparison.OrdinalIgnoreCase);
}

public class DbOptions
{
    public string Server { get; set; } = "localhost";
    public int Port { get; set; } = 3306;
    public string User { get; set; } = "";
    public string Password { get; set; } = "";
    public string Database { get; set; } = "";

    public string ConnectionString =>
        $"Server={Server};Port={Port};User ID={User};Password={Password};" +
        $"Database={Database};Pooling=true;MaximumPoolSize=10;CharSet=utf8mb4;" +
        $"DateTimeKind=Utc;AllowPublicKeyRetrieval=true";
}

public class AnthropicOptions
{
    public string ApiKey { get; set; } = "mock";
    public string Model { get; set; } = "claude-sonnet-4-6";
    public string ModelHeavy { get; set; } = "claude-opus-4-7";
    public bool Mock { get; set; } = true;
}

public class SamsaraOptions
{
    public string Token { get; set; } = "mock";
    public string BaseUrl { get; set; } = "https://api.samsara.com";
    public bool Mock { get; set; } = true;
}

public class AuthOptions
{
    public string JwtSecret { get; set; } = "";
    public int JwtExpiresHours { get; set; } = 8;
    public string CookieSecret { get; set; } = "";
}

public class SyncOptions
{
    public bool Enabled { get; set; } = true;
    public int DriversIntervalMinutes { get; set; } = 60;
    public int VehiclesIntervalMinutes { get; set; } = 60;
    public int HosIntervalMinutes { get; set; } = 5;
}

public class JobsOptions
{
    public bool Enabled { get; set; } = true;
    public string ExpirationAlertsAt { get; set; } = "06:00";
    public string CfrUpdateAt { get; set; } = "04:00";
    public bool CfrUpdateEnabled { get; set; } = true;
}

public class EmailOptions
{
    public bool Mock { get; set; } = true;
    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 587;
    public bool SmtpSecure { get; set; } = false;
    public string SmtpUser { get; set; } = "";
    public string SmtpPass { get; set; } = "";
    public string From { get; set; } = "BOTDOT <noreply@intelogix.mx>";
    public string EscalationsTo { get; set; } = "";
}

public class ChatOptions
{
    public decimal UserDailyBudgetUsd { get; set; } = 5.0m;
    public decimal OrgDailyBudgetUsd { get; set; } = 25.0m;
    public int UserRateLimitPerMin { get; set; } = 30;
}

public class AuditOptions
{
    public int RetentionDays { get; set; } = 730;
}

public class FmcsaOptions
{
    public string Usdot { get; set; } = "2195271";
}
