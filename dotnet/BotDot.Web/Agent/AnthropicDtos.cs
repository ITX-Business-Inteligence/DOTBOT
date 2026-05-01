// DTOs del Messages API de Anthropic — request/response shapes con
// snake_case en wire (matchea spec: input_tokens, stop_reason, etc).
//
// Ref: https://docs.anthropic.com/en/api/messages
//
// NO usamos Anthropic.SDK community para tener control total de shape +
// caching headers + tool use loop matcheando 1:1 al SDK Node oficial.

using System.Text.Json;
using System.Text.Json.Serialization;

namespace BotDot.Web.Agent;

// ─── Request ──────────────────────────────────────────────────

public class AnthropicMessagesRequest
{
    [JsonPropertyName("model")]
    public string Model { get; set; } = "";

    [JsonPropertyName("max_tokens")]
    public int MaxTokens { get; set; } = 4096;

    /// <summary>Texto del system prompt + cache_control. Es un array de blocks.</summary>
    [JsonPropertyName("system")]
    public List<SystemBlock>? System { get; set; }

    [JsonPropertyName("messages")]
    public List<AnthropicMessage> Messages { get; set; } = new();

    [JsonPropertyName("tools")]
    public List<ToolDefinition>? Tools { get; set; }
}

public class SystemBlock
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "text";

    [JsonPropertyName("text")]
    public string Text { get; set; } = "";

    [JsonPropertyName("cache_control")]
    public CacheControl? CacheControl { get; set; }
}

public class CacheControl
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "ephemeral";
}

public class AnthropicMessage
{
    [JsonPropertyName("role")]
    public string Role { get; set; } = "user";

    /// <summary>
    /// Puede ser string (texto plano) o array de ContentBlock (multimodal,
    /// tool_use, tool_result). System.Text.Json acepta object. Cuando
    /// serializamos: si es string sale como "...", si es lista sale como [...].
    /// </summary>
    [JsonPropertyName("content")]
    public object Content { get; set; } = "";
}

public class ToolDefinition
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    /// <summary>JSON Schema del input (object con properties + required).</summary>
    [JsonPropertyName("input_schema")]
    public JsonElement InputSchema { get; set; }
}

// ─── Content blocks (request + response) ──────────────────────

public class ContentBlockText
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "text";

    [JsonPropertyName("text")]
    public string Text { get; set; } = "";
}

public class ContentBlockImage
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "image";

    [JsonPropertyName("source")]
    public ImageSource Source { get; set; } = new();
}

public class ImageSource
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "base64";

    [JsonPropertyName("media_type")]
    public string MediaType { get; set; } = "image/png";

    [JsonPropertyName("data")]
    public string Data { get; set; } = "";
}

public class ContentBlockToolUse
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "tool_use";

    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("input")]
    public JsonElement Input { get; set; }
}

public class ContentBlockToolResult
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "tool_result";

    [JsonPropertyName("tool_use_id")]
    public string ToolUseId { get; set; } = "";

    [JsonPropertyName("content")]
    public string Content { get; set; } = "";

    [JsonPropertyName("is_error")]
    public bool? IsError { get; set; }
}

// ─── Response ─────────────────────────────────────────────────

public class AnthropicMessagesResponse
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("role")]
    public string Role { get; set; } = "";

    [JsonPropertyName("model")]
    public string Model { get; set; } = "";

    /// <summary>
    /// Array de bloques: text / tool_use. Lo deserializamos como JsonElement
    /// raw y lo discriminamos en el ChatService.
    /// </summary>
    [JsonPropertyName("content")]
    public JsonElement Content { get; set; }

    [JsonPropertyName("stop_reason")]
    public string? StopReason { get; set; }

    [JsonPropertyName("usage")]
    public AnthropicUsage? Usage { get; set; }
}

public class AnthropicUsage
{
    [JsonPropertyName("input_tokens")]
    public int? InputTokens { get; set; }

    [JsonPropertyName("output_tokens")]
    public int? OutputTokens { get; set; }

    [JsonPropertyName("cache_read_input_tokens")]
    public int? CacheReadInputTokens { get; set; }

    [JsonPropertyName("cache_creation_input_tokens")]
    public int? CacheCreationInputTokens { get; set; }
}
