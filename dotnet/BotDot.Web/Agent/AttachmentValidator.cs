// Validacion de attachments del chat — equivalente a src/utils/attachments.js Node.
//
// Reglas:
//   - Max 5 imagenes por mensaje
//   - Max 5MB por archivo
//   - MIME types permitidos: image/jpeg, image/png, image/webp, image/gif

using System.Security.Cryptography;

namespace BotDot.Web.Agent;

public static class AttachmentLimits
{
    public const int MaxFilesPerMessage = 5;
    public const long MaxBytesPerFile = 5L * 1024 * 1024;     // 5 MB
    public const long MaxBytesTotalPerMessage = 20L * 1024 * 1024;  // 20 MB total

    public static readonly HashSet<string> AllowedMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
    };
}

public class AttachmentValidationResult
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
}

public static class AttachmentValidator
{
    public static AttachmentValidationResult Validate(IReadOnlyList<UploadedAttachment> files)
    {
        if (files == null || files.Count == 0)
            return new AttachmentValidationResult { Ok = true };

        if (files.Count > AttachmentLimits.MaxFilesPerMessage)
            return new AttachmentValidationResult
            {
                Ok = false,
                Error = $"Maximo {AttachmentLimits.MaxFilesPerMessage} imagenes por mensaje."
            };

        long total = 0;
        foreach (var f in files)
        {
            if (!AttachmentLimits.AllowedMimeTypes.Contains(f.MimeType))
                return new AttachmentValidationResult
                {
                    Ok = false,
                    Error = $"Tipo no permitido: {f.MimeType}. Solo jpeg/png/webp/gif."
                };
            if (f.Size > AttachmentLimits.MaxBytesPerFile)
                return new AttachmentValidationResult
                {
                    Ok = false,
                    Error = $"Una imagen excede {AttachmentLimits.MaxBytesPerFile / 1024 / 1024}MB."
                };
            total += f.Size;
        }

        if (total > AttachmentLimits.MaxBytesTotalPerMessage)
            return new AttachmentValidationResult
            {
                Ok = false,
                Error = "El total de imagenes excede 20MB."
            };

        return new AttachmentValidationResult { Ok = true };
    }

    public static string Sha256Hex(byte[] data)
    {
        var hash = SHA256.HashData(data);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
