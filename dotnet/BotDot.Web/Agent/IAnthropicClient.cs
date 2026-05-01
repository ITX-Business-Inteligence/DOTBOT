// Cliente de Anthropic Messages API. Implementaciones:
//   - AnthropicHttpClient — HttpClient raw POST a /v1/messages
//   - MockClaudeClient   — emulacion local para dev sin API key
//
// La eleccion se hace en Program.cs segun config.Anthropic.Mock.

namespace BotDot.Web.Agent;

public interface IAnthropicClient
{
    Task<AnthropicMessagesResponse> CreateMessageAsync(
        AnthropicMessagesRequest request,
        CancellationToken ct = default);
}
