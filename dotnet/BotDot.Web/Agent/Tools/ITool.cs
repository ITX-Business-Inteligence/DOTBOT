// Interface comun de las tools del agente. Cada tool tiene una Definition
// (schema JSON que se manda a Claude en el request) y un Handler (la
// implementacion local que ejecuta cuando Claude llama a la tool).
//
// Equivalente al pattern src/agent/tools/<name>.js del Node:
//   { definition: {...}, handler: async (input, context) => {...} }

using System.Text.Json;
using BotDot.Web.Auth;

namespace BotDot.Web.Agent.Tools;

public class ToolContext
{
    public AuthUser User { get; set; } = null!;
    public long ConversationId { get; set; }
}

public interface ITool
{
    /// <summary>
    /// Schema declarativo que se envia a Claude. name + description +
    /// input_schema (JSON Schema del input).
    /// </summary>
    ToolDefinition Definition { get; }

    /// <summary>
    /// Ejecuta la tool con el input que mando Claude. Devuelve un objeto
    /// que se serializa como JSON y vuelve a Claude como tool_result.
    /// </summary>
    Task<object?> HandleAsync(JsonElement input, ToolContext context, CancellationToken ct = default);
}

/// <summary>
/// Helper para construir ToolDefinition a partir de C# strings y un objeto
/// schema. El schema se serializa con UnsafeRelaxedJsonEscaping para que el
/// wire format sea limpio.
/// </summary>
public static class ToolDefBuilder
{
    private static readonly JsonSerializerOptions SchemaOpts = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static ToolDefinition Build(string name, string description, object schema)
    {
        return new ToolDefinition
        {
            Name = name,
            Description = description,
            InputSchema = JsonSerializer.SerializeToElement(schema, SchemaOpts),
        };
    }
}
