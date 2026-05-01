// Endpoints /api/admin/drivers/* — admin/compliance.
// Equivalente a la seccion de drivers en src/routes/admin.js Node.

using System.Globalization;
using BotDot.Web.Audit;
using BotDot.Web.Auth;
using BotDot.Web.Data;

namespace BotDot.Web.Routes;

public static class AdminDriversEndpoints
{
    private static readonly RequireAuthFilter AdminOrCompliance = new(Roles.Admin, Roles.Compliance);

    private static readonly Dictionary<string, int> FieldMaxLen = new()
    {
        ["cdl_number"] = 32,
        ["cdl_state"] = 64,
        ["endorsements"] = 64,
        ["phone"] = 32,
        ["company"] = 128,
        ["location"] = 128,
        ["division"] = 128,
        ["notes"] = 4000,
    };

    private static readonly string[] AllowedFields = new[]
    {
        "cdl_number", "cdl_state", "cdl_expiration", "medical_card_expiration",
        "endorsements", "phone", "hire_date", "company", "location", "division",
        "notes", "active",
    };

    private static readonly HashSet<string> DateFields = new()
    {
        "cdl_expiration", "medical_card_expiration", "hire_date",
    };

    private static readonly HashSet<string> AllowedImportMime = new(StringComparer.OrdinalIgnoreCase)
    {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "text/csv",
        "application/csv",
    };
    private static readonly HashSet<string> AllowedImportExt = new(StringComparer.OrdinalIgnoreCase)
    {
        ".xlsx", ".xls", ".csv",
    };

    public static void MapAdminDriversEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/admin")
            .AddEndpointFilter(new RequireAuthFilter())
            .AddEndpointFilter(AdminOrCompliance);

        grp.MapGet("/drivers", ListAsync);
        grp.MapPatch("/drivers/{id:long}", UpdateAsync);
        grp.MapPost("/drivers/import", ImportAsync).DisableAntiforgery();
        grp.MapGet("/drivers/discrepancies", DiscrepanciesAsync);
        grp.MapPost("/drivers/discrepancies/{id:long}/resolve", ResolveDiscrepancyAsync);
    }

    private static async Task<IResult> ListAsync(string? show, IDbAccess db)
    {
        var where = show == "all" ? "" : "WHERE active = 1";
        var rows = await db.QueryAsync<dynamic>(
            $@"SELECT id, samsara_id, full_name, cdl_number, cdl_state, cdl_expiration,
                      medical_card_expiration, endorsements, phone, hire_date,
                      company, location, division, active, data_source, match_confidence, last_synced_at,
                      DATEDIFF(cdl_expiration, CURDATE()) AS cdl_days,
                      DATEDIFF(medical_card_expiration, CURDATE()) AS medical_days
               FROM drivers {where}
               ORDER BY active DESC, full_name ASC
               LIMIT 2000");
        return Results.Json(new { drivers = rows });
    }

    private static async Task<IResult> UpdateAsync(long id, Dictionary<string, object?> body, HttpContext ctx, IDbAccess db, IAuditService audit)
    {
        var actor = ctx.GetUser()!;
        var target = await db.QueryOneAsync<dynamic>("SELECT * FROM drivers WHERE id = @Id", new { Id = id });
        if (target == null) return Results.Json(new { error = "Driver no encontrado" }, statusCode: 404);

        var sets = new List<string>();
        var args = new Dictionary<string, object?>();
        bool touchedCompliance = false;

        foreach (var k in AllowedFields)
        {
            if (!body.TryGetValue(k, out var raw)) continue;

            // JsonElement → primitive
            object? v = raw;
            if (raw is System.Text.Json.JsonElement je)
            {
                v = je.ValueKind switch
                {
                    System.Text.Json.JsonValueKind.String => je.GetString(),
                    System.Text.Json.JsonValueKind.Number => je.TryGetInt64(out var l) ? (object)l : je.GetDouble(),
                    System.Text.Json.JsonValueKind.True => true,
                    System.Text.Json.JsonValueKind.False => false,
                    System.Text.Json.JsonValueKind.Null => null,
                    _ => null,
                };
            }

            if (v is string s)
            {
                if (FieldMaxLen.TryGetValue(k, out var max) && s.Length > max)
                    return Results.Json(new { error = $"{k} excede {max} caracteres" }, statusCode: 400);
                if (DateFields.Contains(k) && !string.IsNullOrEmpty(s) &&
                    !System.Text.RegularExpressions.Regex.IsMatch(s, @"^\d{4}-\d{2}-\d{2}$"))
                    return Results.Json(new { error = $"{k} debe ser YYYY-MM-DD" }, statusCode: 400);
            }

            if (k == "active")
            {
                args[k] = (v is bool b ? b : v != null && !"false".Equals(v.ToString(), StringComparison.OrdinalIgnoreCase)) ? 1 : 0;
            }
            else
            {
                args[k] = (v is string sv && sv == "") ? null : v;
            }
            sets.Add($"{k} = @{k}");
            if (k != "active") touchedCompliance = true;
        }

        if (sets.Count == 0) return Results.Json(new { error = "Nada que actualizar" }, statusCode: 400);

        if (touchedCompliance)
        {
            string targetSrc = ((IDictionary<string, object?>)target).TryGetValue("data_source", out var dsObj) ? dsObj?.ToString() ?? "" : "";
            var newSrc = targetSrc == "samsara" ? "samsara+excel" : "manual";
            sets.Add("data_source = @DataSource");
            args["DataSource"] = newSrc;
            // Admin/compliance edito a mano → confirma vinculacion. Confidence='manual'
            // para que el badge de warning desaparezca.
            sets.Add("match_confidence = @Confidence");
            args["Confidence"] = "manual";
        }

        args["Id"] = id;
        await db.ExecuteAsync($"UPDATE drivers SET {string.Join(", ", sets)} WHERE id = @Id", args);

        await audit.AppendAsync(new AuditEntry
        {
            UserId = actor.Id,
            ActionType = "driver_management",
            SubjectType = "driver",
            SubjectId = id.ToString(),
            Decision = "informational",
            Reasoning = $"{actor.Email} edito driver id={id}",
            Evidence = new Dictionary<string, object?>
            {
                ["changes"] = body,
            },
        });

        var updated = await db.QueryOneAsync<dynamic>("SELECT * FROM drivers WHERE id = @Id", new { Id = id });
        return Results.Json(new { driver = updated });
    }

    private static async Task<IResult> ImportAsync(HttpContext ctx, DriverImporter importer, IAuditService audit, ILogger<DriverImporter> log)
    {
        var actor = ctx.GetUser()!;
        if (!ctx.Request.HasFormContentType)
            return Results.Json(new { error = "Content-Type debe ser multipart/form-data" }, statusCode: 400);

        var form = await ctx.Request.ReadFormAsync();
        var file = form.Files.GetFile("file");
        if (file == null || file.Length == 0)
            return Results.Json(new { error = "Falta archivo (campo 'file')" }, statusCode: 400);

        // Validar MIME / extension
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        var mimeOk = AllowedImportMime.Contains(file.ContentType ?? "");
        var extOk = AllowedImportExt.Contains(ext);
        if (!mimeOk && !extOk)
            return Results.Json(new { error = $"Tipo de archivo no permitido: {file.ContentType} ({ext}). Solo .xlsx, .xls o .csv." }, statusCode: 400);

        // Cap 20MB
        if (file.Length > 20 * 1024 * 1024)
            return Results.Json(new { error = "El archivo excede 20MB." }, statusCode: 400);

        // Sanitizar filename + escribir a disco temporal
        var safeName = SanitizeFilename(file.FileName);
        var importsDir = Path.Combine(AppContext.BaseDirectory, "data", "imports");
        Directory.CreateDirectory(importsDir);
        var filePath = Path.Combine(importsDir, $"import_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{safeName}");
        await using (var fs = File.Create(filePath))
        {
            await file.CopyToAsync(fs);
        }

        var commit = ctx.Request.Query["commit"] == "1";
        DriverImporter.ImportResult result;
        try
        {
            result = await importer.RunAsync(filePath, commit, importedByUserId: actor.Id);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "driver import failed filename={Filename}", file.FileName);
            try { File.Delete(filePath); } catch { }
            return Results.Json(new { error = ex.Message }, statusCode: 500);
        }
        finally
        {
            try { File.Delete(filePath); } catch { }
        }

        if (commit)
        {
            await audit.AppendAsync(new AuditEntry
            {
                UserId = actor.Id,
                ActionType = "driver_management",
                SubjectType = "import_batch",
                SubjectId = result.Summary.BatchId ?? "unknown",
                Decision = "informational",
                Reasoning = $"{actor.Email} importo Excel: {result.MatchesCount} updates, {(result.ExcelOnlyCount ?? 0) + (result.SamsaraOnlyCount ?? 0)} discrepancies",
                Evidence = new Dictionary<string, object?>
                {
                    ["summary"] = result.Summary,
                    ["filename"] = file.FileName,
                },
            });
        }

        return Results.Json(result);
    }

    private static string SanitizeFilename(string filename)
    {
        var basename = Path.GetFileName(filename);
        var sanitized = System.Text.RegularExpressions.Regex.Replace(basename, @"[^a-zA-Z0-9._-]", "_");
        if (sanitized.Length > 80) sanitized = sanitized[..80];
        return string.IsNullOrEmpty(sanitized) ? "upload" : sanitized;
    }

    private static async Task<IResult> DiscrepanciesAsync(string? source, string? resolved, IDbAccess db)
    {
        var clauses = new List<string>();
        var args = new Dictionary<string, object?>();
        if (!string.IsNullOrEmpty(source)) { clauses.Add("source = @Source"); args["Source"] = source; }
        if (resolved != "1") clauses.Add("resolved_at IS NULL");
        var where = clauses.Count > 0 ? "WHERE " + string.Join(" AND ", clauses) : "";
        var rows = await db.QueryAsync<dynamic>(
            $"SELECT * FROM driver_import_discrepancies {where} ORDER BY id DESC LIMIT 500",
            args);
        return Results.Json(new { discrepancies = rows });
    }

    private record ResolveReq(string? Note);

    private static async Task<IResult> ResolveDiscrepancyAsync(long id, ResolveReq? req, HttpContext ctx, IDbAccess db)
    {
        var actor = ctx.GetUser()!;
        var n = await db.ExecuteAsync(
            @"UPDATE driver_import_discrepancies
              SET resolved_at = CURRENT_TIMESTAMP,
                  resolved_by_user_id = @U,
                  resolution_note = @Note
              WHERE id = @Id AND resolved_at IS NULL",
            new { U = actor.Id, Note = req?.Note, Id = id });
        if (n == 0)
            return Results.Json(new { error = "Discrepancia no encontrada o ya resuelta" }, statusCode: 404);
        return Results.Json(new { resolved = true });
    }
}
