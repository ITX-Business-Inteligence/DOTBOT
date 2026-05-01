// ChatService — orquesta el tool use loop del agente.
// Equivalente directo al chat() de src/agent/claude.js del Node.
//
// Flujo de un turn:
//   1. INSERT message role=user (con texto + metadata de attachments)
//   2. Loop iters < MaxToolIterations:
//      a. POST a Anthropic con system prompt cached + tools + messages
//      b. INSERT message role=assistant con response.content + usage tokens
//      c. Si stop_reason in {end_turn, stop_sequence}: salir con texto final
//      d. Si stop_reason == tool_use: ejecutar cada tool, INSERT messages
//         role=tool_use con resultados, agregar tool_results al messages array,
//         continuar loop
//      e. Otro stop_reason raro: salir con texto que haya
//   3. Devolver { text, iterations, toolCallsMade, userMessageId }

using System.Diagnostics;
using System.Text.Json;
using BotDot.Web.Agent.Tools;
using BotDot.Web.Auth;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using Dapper;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Agent;

public class ChatRequest
{
    public AuthUser User { get; set; } = null!;
    public long ConversationId { get; set; }
    public string UserMessage { get; set; } = "";
    public List<UploadedAttachment> Attachments { get; set; } = new();
    public List<AnthropicMessage> History { get; set; } = new();
}

public class UploadedAttachment
{
    public string OriginalName { get; set; } = "";
    public string MimeType { get; set; } = "";
    public byte[] Buffer { get; set; } = Array.Empty<byte>();
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";
}

public class ChatResult
{
    public string Text { get; set; } = "";
    public int Iterations { get; set; }
    public List<ToolCallSummary> ToolCallsMade { get; set; } = new();
    public long UserMessageId { get; set; }
}

public class ToolCallSummary
{
    public string Name { get; set; } = "";
    public JsonElement Input { get; set; }
}

public class ChatService
{
    private const int MaxToolIterations = 8;
    private const int MaxTokens = 4096;

    private readonly IAnthropicClient _llm;
    private readonly ToolRegistry _tools;
    private readonly IDbAccess _db;
    private readonly AnthropicOptions _opts;
    private readonly ILogger<ChatService> _log;

    public ChatService(
        IAnthropicClient llm,
        ToolRegistry tools,
        IDbAccess db,
        IOptions<BotDotOptions> opts,
        ILogger<ChatService> log)
    {
        _llm = llm;
        _tools = tools;
        _db = db;
        _opts = opts.Value.Anthropic;
        _log = log;
    }

    public async Task<ChatResult> ChatAsync(ChatRequest req, CancellationToken ct = default)
    {
        var systemPrompt = SystemPrompt.Build(req.User);

        // Construir el content del user (texto o multimodal)
        object userContentForApi;
        if (req.Attachments.Count > 0)
        {
            var blocks = new List<object>();
            foreach (var att in req.Attachments)
            {
                blocks.Add(new ContentBlockImage
                {
                    Source = new ImageSource
                    {
                        Type = "base64",
                        MediaType = att.MimeType,
                        Data = Convert.ToBase64String(att.Buffer),
                    }
                });
            }
            blocks.Add(new ContentBlockText { Text = req.UserMessage });
            userContentForApi = blocks;
        }
        else
        {
            userContentForApi = req.UserMessage;
        }

        // Persistir el user message en DB (metadata de attachments, no bytes)
        var userContentForLog = new
        {
            text = req.UserMessage,
            attachments = req.Attachments.Select(a => new
            {
                sha256 = a.Sha256,
                mime_type = a.MimeType,
                byte_size = a.Size,
                original_name = a.OriginalName,
            }).ToList(),
        };
        var userMessageId = await LogMessageAsync(req.ConversationId, "user", userContentForLog, null, null);

        // Mensajes que vamos a mandar a Claude — incluye history previo
        var messages = new List<AnthropicMessage>(req.History)
        {
            new() { Role = "user", Content = userContentForApi }
        };

        var toolDefs = _tools.AllDefinitions.ToList();
        var toolCallsMade = new List<ToolCallSummary>();
        var iterations = 0;
        var finalText = "";
        var ctx = new ToolContext { User = req.User, ConversationId = req.ConversationId };

        while (iterations < MaxToolIterations)
        {
            iterations++;
            var sw = Stopwatch.StartNew();

            var response = await _llm.CreateMessageAsync(new AnthropicMessagesRequest
            {
                Model = _opts.Model,
                MaxTokens = MaxTokens,
                System = new List<SystemBlock>
                {
                    new()
                    {
                        Type = "text",
                        Text = systemPrompt,
                        CacheControl = new CacheControl { Type = "ephemeral" }
                    }
                },
                Tools = toolDefs,
                Messages = messages,
            }, ct);

            sw.Stop();
            await LogMessageAsync(req.ConversationId, "assistant", response.Content, response.Usage, sw.ElapsedMilliseconds);

            var stop = response.StopReason ?? "";
            if (stop == "end_turn" || stop == "stop_sequence")
            {
                finalText = ExtractTextBlocks(response.Content);
                messages.Add(new AnthropicMessage { Role = "assistant", Content = response.Content });
                break;
            }

            if (stop == "tool_use")
            {
                messages.Add(new AnthropicMessage { Role = "assistant", Content = response.Content });
                var toolResults = new List<object>();

                foreach (var block in response.Content.EnumerateArray())
                {
                    if (!block.TryGetProperty("type", out var t) || t.GetString() != "tool_use") continue;
                    var toolUseId = block.GetProperty("id").GetString() ?? "";
                    var toolName = block.GetProperty("name").GetString() ?? "";
                    var toolInput = block.TryGetProperty("input", out var ip) ? ip.Clone() : default;

                    toolCallsMade.Add(new ToolCallSummary { Name = toolName, Input = toolInput });

                    object? toolResult;
                    bool isError = false;
                    try
                    {
                        toolResult = await _tools.ExecuteAsync(toolName, toolInput, ctx, ct);
                    }
                    catch (Exception ex)
                    {
                        _log.LogError(ex, "tool {Name} fallo", toolName);
                        toolResult = new { error = ex.Message };
                        isError = true;
                    }

                    await LogMessageAsync(req.ConversationId, "tool_use",
                        new { name = toolName, input = toolInput, result = toolResult, error = isError ? toolResult : null },
                        null, null);

                    toolResults.Add(new ContentBlockToolResult
                    {
                        ToolUseId = toolUseId,
                        Content = JsonSerializer.Serialize(toolResult),
                        IsError = isError ? true : null,
                    });
                }

                messages.Add(new AnthropicMessage { Role = "user", Content = toolResults });
                continue;
            }

            // Cualquier otro stop_reason (max_tokens, etc) — extraer texto y salir
            finalText = ExtractTextBlocks(response.Content);
            messages.Add(new AnthropicMessage { Role = "assistant", Content = response.Content });
            break;
        }

        if (iterations >= MaxToolIterations)
        {
            finalText += "\n\n[Aviso: limite de iteraciones de herramientas alcanzado. Si la respuesta esta incompleta, refina tu pregunta.]";
        }

        return new ChatResult
        {
            Text = finalText,
            Iterations = iterations,
            ToolCallsMade = toolCallsMade,
            UserMessageId = userMessageId,
        };
    }

    private static string ExtractTextBlocks(JsonElement content)
    {
        if (content.ValueKind != JsonValueKind.Array) return "";
        var parts = new List<string>();
        foreach (var block in content.EnumerateArray())
        {
            if (block.TryGetProperty("type", out var t) && t.GetString() == "text" &&
                block.TryGetProperty("text", out var x))
            {
                parts.Add(x.GetString() ?? "");
            }
        }
        return string.Join("\n", parts);
    }

    private async Task<long> LogMessageAsync(long conversationId, string role, object contentJson, AnthropicUsage? usage, long? latencyMs)
    {
        var jsonStr = JsonSerializer.Serialize(contentJson, new JsonSerializerOptions
        {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        var id = await _db.ExecuteInsertAsync(
            @"INSERT INTO messages
                (conversation_id, role, content_json, tokens_input, tokens_output,
                 tokens_cache_read, tokens_cache_create, latency_ms)
              VALUES (@ConvId, @Role, @Content, @In, @Out, @CacheR, @CacheC, @Latency)",
            new
            {
                ConvId = conversationId,
                Role = role,
                Content = jsonStr,
                In = usage?.InputTokens,
                Out = usage?.OutputTokens,
                CacheR = usage?.CacheReadInputTokens,
                CacheC = usage?.CacheCreationInputTokens,
                Latency = latencyMs,
            });
        await _db.ExecuteAsync(
            "UPDATE conversations SET last_activity_at = CURRENT_TIMESTAMP, message_count = message_count + 1 WHERE id = @Id",
            new { Id = conversationId });
        return id;
    }

    /// <summary>
    /// Crea o reusa una conversation. Si conversationId existe Y pertenece al
    /// user → reusar; sino → crear nueva.
    /// </summary>
    public async Task<long> GetOrCreateConversationAsync(long userId, long? conversationId, string? title = null)
    {
        if (conversationId.HasValue)
        {
            var existing = await _db.QueryScalarAsync<long?>(
                "SELECT id FROM conversations WHERE id = @Id AND user_id = @U",
                new { Id = conversationId.Value, U = userId });
            if (existing.HasValue) return existing.Value;
        }
        return await _db.ExecuteInsertAsync(
            "INSERT INTO conversations (user_id, title) VALUES (@U, @T)",
            new { U = userId, T = title ?? "Nueva consulta" });
    }
}
