// Endpoint /api/chat/send minimo — solo JSON, sin multipart upload.
// Multipart + attachments + budget + inflight gate vienen completos en Fase 5.
//
// Por ahora suficiente para validar end-to-end:
//   user message → ChatService → tool use loop → audit row → response

using BotDot.Web.Auth;

namespace BotDot.Web.Agent;

public static class ChatEndpoints
{
    public static void MapChatEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/chat")
            .AddEndpointFilter(new RequireAuthFilter());

        group.MapGet("/conversations", ListConversationsAsync);
        group.MapPost("/send", SendAsync);
    }

    private record SendRequest(string Message, long? ConversationId);

    private static async Task<IResult> SendAsync(
        SendRequest req,
        HttpContext ctx,
        ChatService chat,
        CancellationToken cancel)
    {
        var user = ctx.GetUser()!;

        if (string.IsNullOrWhiteSpace(req.Message))
            return Results.Json(new { error = "Manda un texto." }, statusCode: 400);

        try
        {
            var convId = await chat.GetOrCreateConversationAsync(
                user.Id, req.ConversationId,
                title: req.Message.Length > 80 ? req.Message[..80] : req.Message);

            var result = await chat.ChatAsync(new ChatRequest
            {
                User = user,
                ConversationId = convId,
                UserMessage = req.Message,
                Attachments = new List<UploadedAttachment>(),  // Fase 5 — multipart
                History = new List<AnthropicMessage>(),         // Fase 5 — load history
            }, cancel);

            return Results.Json(new
            {
                conversation_id = convId,
                reply = result.Text,
                iterations = result.Iterations,
                tool_calls = result.ToolCallsMade.Select(tc => tc.Name),
            });
        }
        catch (AnthropicApiException apiEx)
        {
            return apiEx.StatusCode switch
            {
                401 => Results.Json(new { error = "El servicio de IA no esta configurado correctamente. Contacta al administrador (ANTHROPIC_API_KEY invalida o no seteada)." }, statusCode: 503),
                429 => Results.Json(new { error = "El servicio de IA esta saturado. Intenta de nuevo en unos segundos." }, statusCode: 503),
                _ when apiEx.StatusCode >= 500 => Results.Json(new { error = "El servicio de IA esta temporalmente no disponible. Intenta de nuevo en unos minutos." }, statusCode: 503),
                _ => Results.Json(new { error = "Error procesando mensaje", detail = apiEx.Message }, statusCode: 500),
            };
        }
    }

    private static async Task<IResult> ListConversationsAsync(HttpContext ctx, BotDot.Web.Data.IDbAccess db)
    {
        var user = ctx.GetUser()!;
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT id, title, started_at, last_activity_at, message_count
              FROM conversations WHERE user_id = @U
              ORDER BY last_activity_at DESC LIMIT 50",
            new { U = user.Id });
        return Results.Json(new { conversations = rows });
    }
}
