// Serializacion canonica deterministica — port byte-exact del canonicalize()
// del Node (src/db/audit-chain.js).
//
// CRITICO: cualquier diferencia de byte respecto al Node rompe la cadena de
// audit existente (19+ filas en dev). Cualquier cambio aqui requiere correr
// el smoke test:
//   curl http://localhost:5050/api/audit/verify?from=1&to=19
// Debe responder { "intact": true }.
//
// Reglas (matchean V8 / JSON.stringify del Node):
//   - null/undefined → "null"
//   - bool → "true"/"false"
//   - number → String(n) JS (integers sin decimal, floats con decimal)
//   - string → JSON.stringify (double-quoted, escape de "\b\f\n\r\t\"\\,
//     control chars U+0000-U+001F como \u00xx LOWERCASE)
//   - DateTime → JSON.stringify(date.toISOString()) — pero en este modulo
//     las fechas siempre llegan como string ISO precomputado (isoSeconds())
//   - array → "[" + items.map(canon).join(",") + "]"  (sin espacios)
//   - object → "{" + sorted keys (UTF-16 code unit order), cada
//     '"key":canon(value)' joined con "," + "}"  (sin espacios)

using System.Globalization;
using System.Text;
using System.Text.Json;

namespace BotDot.Web.Audit;

public static class Canonicalize
{
    /// <summary>
    /// Serializa un valor de C# (int/long/string/bool/IDictionary/IEnumerable/null)
    /// al string canonico determinista. NO usar para JsonElement — usar
    /// <see cref="SerializeJsonElement"/>.
    /// </summary>
    public static string Serialize(object? value)
    {
        var sb = new StringBuilder();
        AppendValue(sb, value);
        return sb.ToString();
    }

    /// <summary>
    /// Serializa un JsonElement (resultado de parsear evidence_json) al string
    /// canonico. Necesario para que el evidence guardado como JSON en DB y
    /// leido de vuelta produzca los mismos bytes que el objeto original.
    /// </summary>
    public static string SerializeJsonElement(JsonElement element)
    {
        var sb = new StringBuilder();
        AppendJsonElement(sb, element);
        return sb.ToString();
    }

    private static void AppendValue(StringBuilder sb, object? value)
    {
        switch (value)
        {
            case null:
                sb.Append("null");
                break;
            case bool b:
                sb.Append(b ? "true" : "false");
                break;
            case string s:
                AppendString(sb, s);
                break;
            case JsonElement je:
                AppendJsonElement(sb, je);
                break;
            case sbyte or byte or short or ushort or int or uint or long or ulong:
                // Integer: ToString invariant matchea String(int) de JS.
                sb.Append(((IFormattable)value).ToString(null, CultureInfo.InvariantCulture));
                break;
            case float f:
                if (!float.IsFinite(f)) throw new ArgumentException("Numero no finito en canonical");
                sb.Append(NumberToJsString(f));
                break;
            case double d:
                if (!double.IsFinite(d)) throw new ArgumentException("Numero no finito en canonical");
                sb.Append(NumberToJsString(d));
                break;
            case decimal dec:
                sb.Append(NumberToJsString((double)dec));
                break;
            case DateTime dt:
                // Por consistencia con Node (isoSeconds antes de pasar al canonical),
                // formateamos a ISO-8601 con segundos UTC + Z.
                AppendString(sb, dt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture));
                break;
            case System.Collections.IDictionary dict:
                AppendDictionary(sb, dict);
                break;
            case System.Collections.IEnumerable enumerable:
                AppendArray(sb, enumerable);
                break;
            default:
                throw new ArgumentException($"Tipo no canonicalizable: {value.GetType().Name}");
        }
    }

    private static void AppendArray(StringBuilder sb, System.Collections.IEnumerable items)
    {
        sb.Append('[');
        bool first = true;
        foreach (var item in items)
        {
            if (!first) sb.Append(',');
            AppendValue(sb, item);
            first = false;
        }
        sb.Append(']');
    }

    private static void AppendDictionary(StringBuilder sb, System.Collections.IDictionary dict)
    {
        // Ordena las keys en UTF-16 code unit order (matchea Object.keys().sort()
        // del Node — que internamente usa el comparator default = string compare).
        var keys = new List<string>();
        foreach (var k in dict.Keys)
        {
            if (k is not string sk)
                throw new ArgumentException("Solo soportamos keys string en canonicalize");
            keys.Add(sk);
        }
        keys.Sort(StringComparer.Ordinal);

        sb.Append('{');
        bool first = true;
        foreach (var key in keys)
        {
            if (!first) sb.Append(',');
            AppendString(sb, key);
            sb.Append(':');
            AppendValue(sb, dict[key]);
            first = false;
        }
        sb.Append('}');
    }

    private static void AppendJsonElement(StringBuilder sb, JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                sb.Append("null");
                break;
            case JsonValueKind.True:
                sb.Append("true");
                break;
            case JsonValueKind.False:
                sb.Append("false");
                break;
            case JsonValueKind.Number:
                sb.Append(JsonNumberToJsString(el));
                break;
            case JsonValueKind.String:
                AppendString(sb, el.GetString() ?? "");
                break;
            case JsonValueKind.Array:
                sb.Append('[');
                bool firstArr = true;
                foreach (var item in el.EnumerateArray())
                {
                    if (!firstArr) sb.Append(',');
                    AppendJsonElement(sb, item);
                    firstArr = false;
                }
                sb.Append(']');
                break;
            case JsonValueKind.Object:
                var keys = new List<string>();
                foreach (var prop in el.EnumerateObject()) keys.Add(prop.Name);
                keys.Sort(StringComparer.Ordinal);
                sb.Append('{');
                bool firstObj = true;
                foreach (var key in keys)
                {
                    if (!firstObj) sb.Append(',');
                    AppendString(sb, key);
                    sb.Append(':');
                    AppendJsonElement(sb, el.GetProperty(key));
                    firstObj = false;
                }
                sb.Append('}');
                break;
            default:
                throw new ArgumentException($"JsonElement kind no soportado: {el.ValueKind}");
        }
    }

    /// <summary>
    /// Equivalente a JSON.stringify(s) de V8: comillas dobles, escapes de
    /// "\b\f\n\r\t\"\\" como dos chars, control chars U+0000-U+001F como
    /// \u00XX LOWERCASE. Chars >= U+0020 y != " ni \\ se emiten como tal.
    /// </summary>
    private static void AppendString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"':  sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b");  break;
                case '\f': sb.Append("\\f");  break;
                case '\n': sb.Append("\\n");  break;
                case '\r': sb.Append("\\r");  break;
                case '\t': sb.Append("\\t");  break;
                default:
                    if (c < 0x20)
                    {
                        // \u00XX en LOWERCASE — V8/Node lo emite asi.
                        sb.Append("\\u");
                        sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }

    /// <summary>
    /// Equivalente a String(num) de JS:
    ///   - Integer (sin parte fraccional, dentro del rango Int64): sin decimal
    ///   - Float: usa el "shortest round-trip" que JS hace con Number.toString
    /// </summary>
    private static string NumberToJsString(double d)
    {
        if (d == Math.Floor(d) && !double.IsInfinity(d) && d >= long.MinValue && d <= long.MaxValue)
        {
            // Es un entero — emitir sin decimal.
            // -0 → "0" (JS String(-0) === "0")
            if (d == 0.0) return "0";
            return ((long)d).ToString(CultureInfo.InvariantCulture);
        }
        // Float: "R" round-trip da el shortest unique representation.
        // Para los casos que vamos a ver en audit (raros, casi siempre son ints)
        // esto deberia matchear JS Number.prototype.toString.
        return d.ToString("R", CultureInfo.InvariantCulture);
    }

    private static string JsonNumberToJsString(JsonElement numEl)
    {
        // System.Text.Json preserva el texto crudo del numero — pero la regla
        // del Node es JSON.parse → Number → String, lo que normaliza.
        // Por ejemplo "1.0" llega como JsonElement de tipo Number con raw "1.0",
        // pero JS lo serializaria como "1". Asi que reparseamos.
        if (numEl.TryGetInt64(out var l)) return l.ToString(CultureInfo.InvariantCulture);
        if (numEl.TryGetDouble(out var d)) return NumberToJsString(d);
        // fallback — uso del raw text (no deberia pasar para data realista)
        return numEl.GetRawText();
    }
}
