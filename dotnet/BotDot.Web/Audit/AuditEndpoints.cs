// Endpoints de /api/audit/* — equivalente a src/routes/audit.js del Node.
// Acceso: SOLO admin / compliance.

using BotDot.Web.Auth;

namespace BotDot.Web.Audit;

public static class AuditEndpoints
{
    /// <summary>
    /// Cap default de filas por request a /verify para prevenir DoS interno
    /// (matchea M7 fix del audit Node — full table scan + N SHA-256 escala mal
    /// con miles de filas).
    /// </summary>
    public const int MaxRowsPerRequest = 1000;

    public static void MapAuditEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/audit")
            .AddEndpointFilter(new RequireAuthFilter(Roles.Admin, Roles.Compliance));

        group.MapGet("/head", GetHeadAsync);
        group.MapGet("/verify", VerifyAsync);
    }

    private static async Task<IResult> GetHeadAsync(AuditVerifier verifier)
    {
        var head = await verifier.GetHeadAsync();
        return Results.Json(new
        {
            audit_id = head.AuditId,
            row_hash = head.RowHash,
            created_at = head.CreatedAt?.ToString("O")
        });
    }

    private static async Task<IResult> VerifyAsync(
        AuditVerifier verifier,
        HttpContext ctx,
        long? from = null,
        long? to = null,
        bool full = false)
    {
        var user = ctx.GetUser()!;

        if (full && user.Role != Roles.Admin)
            return Results.Json(new { error = "full=1 requiere rol admin" }, statusCode: 403);

        bool capped = false;
        long? effFrom = from;
        long? effTo = to;

        if (!full && from == null && to == null)
        {
            // Sin rango → capear a las ultimas MAX_ROWS filas.
            var head = await verifier.GetHeadAsync();
            if (head.AuditId.HasValue && head.AuditId.Value > MaxRowsPerRequest)
            {
                effFrom = head.AuditId.Value - MaxRowsPerRequest + 1;
                effTo = head.AuditId.Value;
                capped = true;
            }
        }
        else if (!full && from.HasValue && to.HasValue && (to.Value - from.Value + 1) > MaxRowsPerRequest)
        {
            return Results.Json(new
            {
                error = $"Rango excede {MaxRowsPerRequest} filas. Usa rangos mas chicos o ?full=1 (admin)."
            }, statusCode: 400);
        }

        var result = await verifier.VerifyAsync(new AuditVerifyOptions { From = effFrom, To = effTo });
        if (capped) result.RangeCapped = true;

        // Status 200 si intacta, 409 si hay rupturas (matchea Node).
        return Results.Json(new
        {
            rows_checked = result.RowsChecked,
            intact = result.Intact,
            head_hash = result.HeadHash,
            head_audit_id = result.HeadAuditId,
            issues = result.Issues.Select(i => new
            {
                audit_id = i.AuditId,
                type = i.Type,
                expected_prev_hash = i.ExpectedPrevHash,
                actual_prev_hash = i.ActualPrevHash,
                stored_row_hash = i.StoredRowHash,
                recomputed_row_hash = i.RecomputedRowHash,
            }),
            range_capped = result.RangeCapped,
        }, statusCode: result.Intact ? 200 : 409);
    }
}
