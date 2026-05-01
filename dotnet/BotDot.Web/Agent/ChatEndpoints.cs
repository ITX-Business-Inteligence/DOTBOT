// Endpoints de /api/chat/* — equivalente a src/routes/chat.js del Node.
//
//   GET  /api/chat/conversations                 — list conversaciones del user
//   GET  /api/chat/conversations/:id/messages    — load historial
//   GET  /api/chat/attachments/:id               — blob serve, no-store
//   POST /api/chat/send                          — multipart: message + 0-5 imagenes
//
// /send pipeline:
//   1. Auth (cookie) + rate limit (chat-send-user 30/min)
//   2. Parse multipart: message + files[]
//   3. Validate attachments (mime, size, count)
//   4. Inflight gate (rechaza si ya hay request en vuelo del user)
//   5. Budget cap check (USD 24h rolling, user + org)
//   6. ChatService.ChatAsync → tool use loop
//   7. Persistir attachments en message_attachments
//   8. Return { reply, conversation_id, iterations, tool_calls, attachments }

using System.Text.Json;
using BotDot.Web.Auth;
using BotDot.Web.Data;
using Dapper;

namespace BotDot.Web.Agent;

public static class ChatEndpoints
{
    public static void MapChatEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/chat")
            .AddEndpointFilter(new RequireAuthFilter());

        group.MapGet("/conversations", ListConversationsAsync);
        group.MapGet("/conversations/{id:long}/messages", GetMessagesAsync);
        group.MapGet("/attachments/{id:long}", GetAttachmentAsync);
        group.MapPost("/send", SendAsync)
             .DisableAntiforgery()                       // multipart sin token CSRF (cookie SameSite=Strict cubre)
             .RequireRateLimiting("chat-send-user");
    }

    // ─── GET /conversations ─────────────────────────────────────

    private static async Task<IResult> ListConversationsAsync(HttpContext ctx, IDbAccess db)
    {
        var user = ctx.GetUser()!;
        var rows = await db.QueryAsync<dynamic>(
            @"SELECT id, title, started_at, last_activity_at, message_count
              FROM conversations WHERE user_id = @U
              ORDER BY last_activity_at DESC LIMIT 50",
            new { U = user.Id });
        return Results.Json(new { conversations = rows });
    }

    // ─── GET /conversations/:id/messages ─────────────────────────
    // IDOR-safe: WHERE user_id = @U garantiza que solo el dueno puede leer.

    private static async Task<IResult> GetMessagesAsync(long id, HttpContext ctx, IDbAccess db)
    {
        var user = ctx.GetUser()!;
        var conv = await db.QueryOneAsync<ConvIdRow>(
            "SELECT id AS Id FROM conversations WHERE id = @Id AND user_id = @U",
            new { Id = id, U = user.Id });
        if (conv == null) return Results.Json(new { error = "Conversacion no encontrada" }, statusCode: 404);

        var rows = await db.QueryAsync<MessageRow>(
            @"SELECT id AS Id, role AS Role, content_json AS ContentJson, created_at AS CreatedAt
              FROM messages WHERE conversation_id = @Id ORDER BY id ASC",
            new { Id = id });

        var serialized = rows.Select(r => new
        {
            id = r.Id,
            role = r.Role,
            content = r.ContentJson != null ? JsonDocument.Parse(r.ContentJson).RootElement : default,
            created_at = r.CreatedAt,
        });
        return Results.Json(new { messages = serialized });
    }

    private class ConvIdRow { public long Id { get; set; } }
    private class MessageRow
    {
        public long Id { get; set; }
        public string Role { get; set; } = "";
        public string? ContentJson { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    // ─── GET /attachments/:id ───────────────────────────────────
    // Owner del thread O role privilegiado (admin/compliance) puede ver.

    private static async Task<IResult> GetAttachmentAsync(long id, HttpContext ctx, IDbAccess db)
    {
        var user = ctx.GetUser()!;
        var att = await db.QueryOneAsync<AttachmentRow>(
            @"SELECT a.id AS Id, a.user_id AS UserId, a.mime_type AS MimeType,
                     a.byte_size AS ByteSize, a.content_blob AS ContentBlob,
                     a.conversation_id AS ConversationId, c.user_id AS ConvOwner
              FROM message_attachments a
              JOIN conversations c ON c.id = a.conversation_id
              WHERE a.id = @Id",
            new { Id = id });
        if (att == null) return Results.Json(new { error = "Adjunto no encontrado" }, statusCode: 404);

        var isOwner = att.ConvOwner == user.Id;
        var isPrivileged = user.Role == Roles.Admin || user.Role == Roles.Compliance;
        if (!isOwner && !isPrivileged)
            return Results.Json(new { error = "No autorizado" }, statusCode: 403);

        // Cache-Control no-store — fix L7 del audit del Node, evita leak en
        // browsers compartidos.
        ctx.Response.Headers["Cache-Control"] = "no-store";
        return Results.File(att.ContentBlob, att.MimeType);
    }

    private class AttachmentRow
    {
        public long Id { get; set; }
        public long UserId { get; set; }
        public string MimeType { get; set; } = "";
        public long ByteSize { get; set; }
        public byte[] ContentBlob { get; set; } = Array.Empty<byte>();
        public long ConversationId { get; set; }
        public long ConvOwner { get; set; }
    }

    // ─── POST /send ─────────────────────────────────────────────

    private static async Task<IResult> SendAsync(
        HttpContext ctx,
        ChatService chat,
        IDbAccess db,
        IInflightGate inflight,
        BudgetService budget,
        ILogger<ChatService> log,
        CancellationToken cancel)
    {
        var user = ctx.GetUser()!;

        if (!ctx.Request.HasFormContentType)
            return Results.Json(new { error = "Content-Type debe ser multipart/form-data" }, statusCode: 400);

        var form = await ctx.Request.ReadFormAsync(cancel);
        var message = (form["message"].FirstOrDefault() ?? "").Trim();
        var convIdStr = form["conversation_id"].FirstOrDefault();
        long? requestedConvId = long.TryParse(convIdStr, out var cId) ? cId : null;

        // Recolectar archivos
        var attachments = new List<UploadedAttachment>();
        foreach (var file in form.Files.GetFiles("files"))
        {
            using var ms = new MemoryStream();
            await file.CopyToAsync(ms, cancel);
            var buf = ms.ToArray();
            attachments.Add(new UploadedAttachment
            {
                OriginalName = file.FileName,
                MimeType = file.ContentType ?? "application/octet-stream",
                Buffer = buf,
                Size = buf.LongLength,
                Sha256 = AttachmentValidator.Sha256Hex(buf),
            });
        }

        if (string.IsNullOrEmpty(message) && attachments.Count == 0)
            return Results.Json(new { error = "Manda un texto, una imagen, o ambos." }, statusCode: 400);

        var v = AttachmentValidator.Validate(attachments);
        if (!v.Ok) return Results.Json(new { error = v.Error }, statusCode: 400);

        // Inflight gate
        if (!inflight.MarkInflight(user.Id))
        {
            return Results.Json(new
            {
                error = "Ya tienes una solicitud en curso. Espera la respuesta antes de enviar otra."
            }, statusCode: 429);
        }

        try
        {
            // Budget cap
            BudgetCheckResult budgetResult;
            try
            {
                budgetResult = await budget.CheckAsync(user.Id);
            }
            catch (Exception ex)
            {
                log.LogError(ex, "budget check fail-open");
                budgetResult = new BudgetCheckResult { Allowed = true };
            }
            if (!budgetResult.Allowed)
            {
                log.LogWarning("budget cap hit scope={Scope} user_id={UserId}", budgetResult.Scope, user.Id);
                return Results.Json(new
                {
                    error = "Has alcanzado el limite de uso. Intenta mas tarde o contacta a un administrador si necesitas mas capacidad."
                }, statusCode: 429);
            }

            var convId = await chat.GetOrCreateConversationAsync(
                user.Id, requestedConvId,
                title: TitleFor(message, attachments));

            var history = await LoadHistoryAsync(db, convId);

            var result = await chat.ChatAsync(new ChatRequest
            {
                User = user,
                ConversationId = convId,
                UserMessage = message,
                Attachments = attachments,
                History = history,
            }, cancel);

            // Persistir attachments — DESPUES del chat para que tengamos
            // el userMessageId valido (FK a messages.id).
            var attachmentRows = new List<object>();
            foreach (var a in attachments)
            {
                var attId = await db.ExecuteInsertAsync(
                    @"INSERT INTO message_attachments
                        (message_id, conversation_id, user_id, mime_type, byte_size, sha256, storage_kind, content_blob)
                      VALUES (@MsgId, @ConvId, @UserId, @Mime, @Size, @Sha, 'db', @Blob)",
                    new
                    {
                        MsgId = result.UserMessageId,
                        ConvId = convId,
                        UserId = user.Id,
                        Mime = a.MimeType,
                        Size = a.Size,
                        Sha = a.Sha256,
                        Blob = a.Buffer,
                    });
                attachmentRows.Add(new
                {
                    id = attId,
                    mime_type = a.MimeType,
                    byte_size = a.Size,
                    sha256 = a.Sha256,
                    original_name = a.OriginalName,
                });
            }

            return Results.Json(new
            {
                conversation_id = convId,
                reply = result.Text,
                iterations = result.Iterations,
                tool_calls = result.ToolCallsMade.Select(tc => tc.Name),
                attachments = attachmentRows,
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
        finally
        {
            inflight.Clear(user.Id);
        }
    }

    private static string TitleFor(string message, List<UploadedAttachment> attachments)
    {
        if (!string.IsNullOrEmpty(message))
            return message.Length > 80 ? message[..80] : message;
        if (attachments.Count > 0) return $"{attachments.Count} imagen(es)";
        return "Nueva consulta";
    }

    /// <summary>
    /// Carga historial reciente de la conversacion en formato Anthropic.
    /// Solo user/assistant — tool_use intermedios se reconstruyen a partir
    /// de los content_json de assistant. Las imagenes pasadas NO se reenvian
    /// (costo prohibitivo, decision matchea Node).
    /// </summary>
    private static async Task<List<AnthropicMessage>> LoadHistoryAsync(IDbAccess db, long convId, int limit = 30)
    {
        var rows = await db.QueryAsync<MessageRow>(
            @"SELECT id AS Id, role AS Role, content_json AS ContentJson, created_at AS CreatedAt
              FROM messages
              WHERE conversation_id = @Id AND role IN ('user','assistant')
              ORDER BY id ASC LIMIT @Limit",
            new { Id = convId, Limit = limit });

        var history = new List<AnthropicMessage>();
        foreach (var r in rows)
        {
            if (string.IsNullOrEmpty(r.ContentJson)) continue;
            using var doc = JsonDocument.Parse(r.ContentJson);
            var content = doc.RootElement.Clone();

            if (r.Role == "user")
            {
                // tool_result blocks (cuando el loop empuja al user role) son arrays
                if (content.ValueKind == JsonValueKind.Array)
                {
                    history.Add(new AnthropicMessage { Role = "user", Content = content });
                }
                else
                {
                    // Mensaje user normal: { text, attachments[] }
                    var text = content.TryGetProperty("text", out var t) ? t.GetString() ?? "" : content.GetRawText();
                    if (content.TryGetProperty("attachments", out var atts) &&
                        atts.ValueKind == JsonValueKind.Array && atts.GetArrayLength() > 0)
                    {
                        var n = atts.GetArrayLength();
                        text += $"\n\n[En este turn el usuario adjunto {n} imagen(es). No las tienes a la vista ahora; si necesitas verlas pide que las reenvie.]";
                    }
                    history.Add(new AnthropicMessage { Role = "user", Content = text });
                }
            }
            else
            {
                history.Add(new AnthropicMessage { Role = "assistant", Content = content });
            }
        }
        return history;
    }
}
