// Email service — interface + mock + MailKit real (Fase 7 lo afina con SMTP prod).
//
// El mock loggea a stderr en vez de enviar email real — util en dev sin SMTP.
// Activacion: BotDot:Email:Mock=true (default en dev).
//
// Equivalente a src/utils/email.js del Node.

using BotDot.Web.Configuration;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Options;
using MimeKit;

namespace BotDot.Web.Email;

public class EmailMessage
{
    public List<string> To { get; set; } = new();
    public string Subject { get; set; } = "";
    public string Text { get; set; } = "";
    public string? Html { get; set; }
}

public class EmailSendResult
{
    public bool Sent { get; set; }
    public string? Error { get; set; }
}

public interface IEmailService
{
    Task<EmailSendResult> SendAsync(EmailMessage msg, CancellationToken ct = default);
}

/// <summary>
/// Mock — no envia, solo loggea. NUNCA bloquea el flow del caller.
/// </summary>
public class MockEmailService : IEmailService
{
    private readonly ILogger<MockEmailService> _log;
    public MockEmailService(ILogger<MockEmailService> log) => _log = log;

    public Task<EmailSendResult> SendAsync(EmailMessage msg, CancellationToken ct = default)
    {
        _log.LogInformation(
            "[EMAIL MOCK] to={To} subject={Subject} text_chars={TextLen}",
            string.Join(",", msg.To), msg.Subject, msg.Text.Length);
        return Task.FromResult(new EmailSendResult { Sent = true });
    }
}

/// <summary>
/// MailKit-based SMTP client. Fail-safe: si SMTP falla, devuelve EmailSendResult
/// con error pero NO tira excepcion — el caller decide.
/// </summary>
public class MailKitEmailService : IEmailService
{
    private readonly EmailOptions _opts;
    private readonly ILogger<MailKitEmailService> _log;

    public MailKitEmailService(IOptions<BotDotOptions> opts, ILogger<MailKitEmailService> log)
    {
        _opts = opts.Value.Email;
        _log = log;
    }

    public async Task<EmailSendResult> SendAsync(EmailMessage msg, CancellationToken ct = default)
    {
        try
        {
            var mime = new MimeMessage();
            // From — formato "Display Name <email@host>" se parsea con MailboxAddress.Parse
            mime.From.Add(MailboxAddress.Parse(_opts.From));
            foreach (var to in msg.To) mime.To.Add(MailboxAddress.Parse(to));
            mime.Subject = msg.Subject;

            var body = new BodyBuilder { TextBody = msg.Text };
            if (!string.IsNullOrEmpty(msg.Html)) body.HtmlBody = msg.Html;
            mime.Body = body.ToMessageBody();

            using var client = new SmtpClient();
            await client.ConnectAsync(_opts.SmtpHost, _opts.SmtpPort,
                _opts.SmtpSecure ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTlsWhenAvailable, ct);
            if (!string.IsNullOrEmpty(_opts.SmtpUser))
                await client.AuthenticateAsync(_opts.SmtpUser, _opts.SmtpPass, ct);
            await client.SendAsync(mime, ct);
            await client.DisconnectAsync(true, ct);

            _log.LogInformation("Email enviado a {To} subject={Subject}", string.Join(",", msg.To), msg.Subject);
            return new EmailSendResult { Sent = true };
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Email send failed to={To}", string.Join(",", msg.To));
            return new EmailSendResult { Sent = false, Error = ex.Message };
        }
    }
}
