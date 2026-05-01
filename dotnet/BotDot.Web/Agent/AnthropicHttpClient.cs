// Cliente HTTP a Anthropic Messages API. NO usamos Anthropic.SDK community
// porque lag detras del oficial Node y queremos control total del wire format.
//
// Auth: x-api-key + anthropic-version header. NO usa Bearer.
// Caching: cache_control en system block (ephemeral 5 min) — el server hace
// el caching automatico cuando ve el mismo prefix.

using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using BotDot.Web.Configuration;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Agent;

public class AnthropicHttpClient : IAnthropicClient
{
    private const string ApiBaseUrl = "https://api.anthropic.com";
    private const string ApiVersion = "2023-06-01";

    private readonly HttpClient _http;
    private readonly AnthropicOptions _opts;
    private readonly ILogger<AnthropicHttpClient> _log;

    private static readonly JsonSerializerOptions SerOpts = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public AnthropicHttpClient(IHttpClientFactory factory, IOptions<BotDotOptions> opts, ILogger<AnthropicHttpClient> log)
    {
        _http = factory.CreateClient("anthropic");
        _opts = opts.Value.Anthropic;
        _log = log;

        _http.BaseAddress = new Uri(ApiBaseUrl);
        _http.Timeout = TimeSpan.FromMinutes(2);   // Claude puede tardar en respuestas largas
        _http.DefaultRequestHeaders.Add("anthropic-version", ApiVersion);
        _http.DefaultRequestHeaders.Add("x-api-key", _opts.ApiKey);
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("BOTDOT", "0.2.0"));
    }

    public async Task<AnthropicMessagesResponse> CreateMessageAsync(
        AnthropicMessagesRequest request,
        CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(request, SerOpts);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");

        var t0 = DateTime.UtcNow;
        using var resp = await _http.PostAsync("/v1/messages", content, ct);
        var elapsed = (DateTime.UtcNow - t0).TotalMilliseconds;

        var body = await resp.Content.ReadAsStringAsync(ct);

        if (!resp.IsSuccessStatusCode)
        {
            _log.LogError(
                "Anthropic API error {Status} en {ElapsedMs}ms: {Body}",
                (int)resp.StatusCode, elapsed, body.Length > 500 ? body[..500] : body);
            // Tirar excepcion con HTTP status para que el caller pueda mapear
            // a 503 (config), 429 (rate), etc.
            var ex = new AnthropicApiException(
                $"Anthropic API {resp.StatusCode}: {body}",
                (int)resp.StatusCode);
            throw ex;
        }

        var parsed = JsonSerializer.Deserialize<AnthropicMessagesResponse>(body)
            ?? throw new InvalidOperationException("Anthropic respondio body vacio o no parseable");

        _log.LogDebug(
            "Anthropic OK stop_reason={StopReason} input={InputTok} output={OutputTok} cache_read={CacheRead} elapsed_ms={ElapsedMs}",
            parsed.StopReason, parsed.Usage?.InputTokens, parsed.Usage?.OutputTokens,
            parsed.Usage?.CacheReadInputTokens, elapsed);

        return parsed;
    }
}

public class AnthropicApiException : Exception
{
    public int StatusCode { get; }
    public AnthropicApiException(string message, int statusCode) : base(message)
    {
        StatusCode = statusCode;
    }
}
