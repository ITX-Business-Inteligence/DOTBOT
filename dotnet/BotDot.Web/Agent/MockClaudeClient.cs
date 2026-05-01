// MockClaudeClient — emula la API de Anthropic Messages localmente para
// que el ChatService funcione end-to-end SIN llamar a Claude real.
//
// Activacion: BotDot:Anthropic:Mock=true en appsettings (default en dev).
//
// Que ejercita:
//   ✓ Tool loop (tool_use → tool_result → end_turn)
//   ✓ Audit log (log_off_topic, log_refused_request, log_decision)
//   ✓ Multipart upload + persistencia de message_attachments
//   ✓ Concurrency gate, rate limit, todo el flujo del ChatService
//
// Que NO ejercita (necesita Claude real):
//   ✗ Razonamiento HOS / sintesis multi-tool
//   ✗ Redaccion natural de respuestas
//   ✗ Resistencia a prompt injection (las reglas estan, pero solo Claude
//     real demuestra que las cumple)
//
// Port pragmatico del src/agent/mock-llm.js del Node — patrones suficientes
// para validar el wire format del cliente, no fidelidad 1:1.

using System.Text.Json;

namespace BotDot.Web.Agent;

public class MockClaudeClient : IAnthropicClient
{
    private const string RedirectPhrase =
        "Estoy disenado solo para apoyo de compliance DOT/FMCSA. " +
        "En que tema de regulacion, HOS, BASICs, asignaciones, inspecciones o coaching te puedo ayudar?";

    // Si el ultimo user message es un array de tool_result blocks (loop step
    // siguiente al tool_use de la respuesta anterior), respondemos con texto
    // final — cierra el ciclo.
    private static readonly string[] DotKeywords = new[]
    {
        "cfr", "fmcsa", "dot", "usdot", "compliance", "49 cfr",
        "hos", "hours of service", "horas", "manejo", "maneja", "driving", "11 hor", "14 hor", "70 hor",
        "sleeper berth", "personal conveyance", "rods",
        "basic", "sms", "csa", "percentil", "unsafe driving", "driver fitness", "vehicle maint",
        "crash indicator", "hazmat",
        "driver", "chofer", "vehiculo", "unidad", "load", "asignacion", "asignar", "dispatch",
        "dataqs", "inspeccion", "inspection", "roadside", "dvir", "oos", "out of service",
        "crash", "preventability", "clearinghouse", "cdl", "medical card",
        "2195271", "intelogix",
    };

    private static readonly string[] InjectionKeywords = new[]
    {
        "ignora tus instrucciones", "ignora las reglas", "modo desarrollador",
        "actua como", "actuá como", "eres un asistente diferente", "tu sistema admin", "el admin te autoriza",
        "sin disclaimer", "sin reglas", "haz de cuenta que",
    };

    private static readonly string[] EvasionKeywords = new[]
    {
        "false log", "falsificar", "editar el log", "ocultar la violacion",
        "pc abuse", "personal conveyance abuse", "manipular eld",
    };

    public Task<AnthropicMessagesResponse> CreateMessageAsync(
        AnthropicMessagesRequest request,
        CancellationToken ct = default)
    {
        var lastText = ExtractLastUserText(request.Messages);
        var isToolResultStep = IsLastUserToolResult(request.Messages);

        // Si venimos de un tool_result (segunda iteracion del loop), cerramos
        // con texto final.
        if (isToolResultStep)
        {
            return Task.FromResult(BuildEndTurn(
                "Listo, registre el evento. " +
                "[respuesta de mock — el bot real produciria razonamiento basado en los tool results aqui]\n\n" +
                "Esto no constituye asesoria legal. La decision final es responsabilidad del dispatcher / supervisor / compliance officer."));
        }

        var clas = Classify(lastText);

        return clas switch
        {
            "injection" => Task.FromResult(BuildToolUse("log_off_topic", new Dictionary<string, object?>
                {
                    ["request_summary"] = "Intento de injection (mensaje del usuario)",
                    ["category"] = "injection_attempt",
                }, RedirectPhrase)),

            "evasion" => Task.FromResult(BuildToolUse("log_refused_request", new Dictionary<string, object?>
                {
                    ["request_summary"] = lastText.Length > 200 ? lastText[..200] + "..." : lastText,
                    ["reason_refused"] = "Solicita evadir compliance DOT — rechazado por regla 4 del system prompt",
                    ["cfr_violated_if_done"] = "49 CFR 395.8(e) (RODS falsificacion); otras segun caso",
                }, "No puedo ayudarte con eso — viola DOT. Si tienes una pregunta legitima de compliance, con gusto.")),

            "off_topic" => Task.FromResult(BuildToolUse("log_off_topic", new Dictionary<string, object?>
                {
                    ["request_summary"] = lastText.Length > 200 ? lastText[..200] + "..." : lastText,
                    ["category"] = DetectOffTopicCategory(lastText),
                }, RedirectPhrase)),

            "greeting" => Task.FromResult(BuildToolUse("log_off_topic", new Dictionary<string, object?>
                {
                    ["request_summary"] = "Saludo / conversacion casual",
                    ["category"] = "greeting",
                }, RedirectPhrase)),

            // dot — respuesta de prueba con texto final (sin tool real, los tools se ejercitan en otro path)
            _ => Task.FromResult(BuildEndTurn(
                "[Mock LLM] Recibi tu pregunta DOT. " +
                "Un Claude real consultaria las herramientas relevantes (samsara_*, search_cfr, query_*) " +
                "y devolveria una recomendacion con cita CFR. " +
                "Para validar el flow real necesitas BOTDOT_MOCK_LLM=false + ANTHROPIC_API_KEY.\n\n" +
                "Esto no constituye asesoria legal. La decision final es responsabilidad del dispatcher / supervisor / compliance officer.")),
        };
    }

    // ─── classify helpers ────────────────────────────────────────

    private static string Classify(string text)
    {
        var t = (text ?? "").ToLowerInvariant().Trim();
        if (string.IsNullOrEmpty(t)) return "off_topic";
        if (InjectionKeywords.Any(k => t.Contains(k))) return "injection";
        if (EvasionKeywords.Any(k => t.Contains(k))) return "evasion";
        if (DotKeywords.Any(k => t.Contains(k))) return "dot";
        if (System.Text.RegularExpressions.Regex.IsMatch(t,
            @"^(hola|buenas|hey|hi|gracias|ok|si|no|adios|buen dia)\b"))
            return "greeting";
        return "off_topic";
    }

    private static string DetectOffTopicCategory(string text)
    {
        var t = (text ?? "").ToLowerInvariant();
        if (InjectionKeywords.Any(k => t.Contains(k))) return "injection_attempt";
        if (System.Text.RegularExpressions.Regex.IsMatch(t,
            @"python|javascript|codigo|script|programa|debug|funcion"))
            return "coding";
        if (System.Text.RegularExpressions.Regex.IsMatch(t.TrimStart(),
            @"^(hola|buenas|hey|hi|gracias|ok|adios)"))
            return "greeting";
        if (System.Text.RegularExpressions.Regex.IsMatch(t,
            @"receta|comida|deporte|pelicula|musica"))
            return "creative";
        if (System.Text.RegularExpressions.Regex.IsMatch(t,
            @"personal|amigo|familia|relacion|salud|finanzas|mi vida"))
            return "personal";
        return "other";
    }

    private static string ExtractLastUserText(List<AnthropicMessage> messages)
    {
        for (int i = messages.Count - 1; i >= 0; i--)
        {
            var m = messages[i];
            if (m.Role != "user") continue;
            if (m.Content is string s) return s;
            // Cuando es array de blocks (multimodal o tool_result), buscamos el text block
            if (m.Content is JsonElement je && je.ValueKind == JsonValueKind.Array)
            {
                foreach (var block in je.EnumerateArray())
                {
                    if (block.TryGetProperty("type", out var typeEl) &&
                        typeEl.GetString() == "text" &&
                        block.TryGetProperty("text", out var textEl))
                    {
                        return textEl.GetString() ?? "";
                    }
                }
            }
            // Tambien soportamos List<object> (cuando se construyo en C#)
            if (m.Content is System.Collections.IEnumerable items)
            {
                foreach (var item in items)
                {
                    if (item is ContentBlockText cbt) return cbt.Text;
                }
            }
            return "";
        }
        return "";
    }

    private static bool IsLastUserToolResult(List<AnthropicMessage> messages)
    {
        if (messages.Count == 0) return false;
        var last = messages[^1];
        if (last.Role != "user") return false;
        if (last.Content is JsonElement je && je.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in je.EnumerateArray())
            {
                if (block.TryGetProperty("type", out var typeEl) &&
                    typeEl.GetString() == "tool_result")
                    return true;
            }
            return false;
        }
        if (last.Content is System.Collections.IEnumerable items)
        {
            foreach (var item in items)
            {
                if (item is ContentBlockToolResult) return true;
            }
        }
        return false;
    }

    // ─── response builders ───────────────────────────────────────

    private static AnthropicMessagesResponse BuildEndTurn(string text)
    {
        var contentJson = JsonSerializer.SerializeToElement(new[]
        {
            new { type = "text", text = text }
        });
        return new AnthropicMessagesResponse
        {
            Id = "msg_mock_" + Guid.NewGuid().ToString("N")[..12],
            Type = "message",
            Role = "assistant",
            Model = "mock-claude",
            Content = contentJson,
            StopReason = "end_turn",
            Usage = new AnthropicUsage
            {
                InputTokens = 100,
                OutputTokens = (text.Length / 4),
            }
        };
    }

    private static AnthropicMessagesResponse BuildToolUse(
        string toolName, Dictionary<string, object?> input, string textPreamble)
    {
        var content = new[]
        {
            (object) new { type = "text", text = textPreamble },
            (object) new
            {
                type = "tool_use",
                id = "mock_tu_" + Guid.NewGuid().ToString("N")[..12],
                name = toolName,
                input = input,
            }
        };
        var contentJson = JsonSerializer.SerializeToElement(content);
        return new AnthropicMessagesResponse
        {
            Id = "msg_mock_" + Guid.NewGuid().ToString("N")[..12],
            Type = "message",
            Role = "assistant",
            Model = "mock-claude",
            Content = contentJson,
            StopReason = "tool_use",
            Usage = new AnthropicUsage
            {
                InputTokens = 100,
                OutputTokens = 50,
            }
        };
    }
}
