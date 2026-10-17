using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HermesApproval.Core;

/// <summary>
/// Stable JSON text: object keys sorted at every depth, numbers normalised.
/// Two payloads are "the same request" for the guard when their canonical strings match.
/// </summary>
public static class Canonical
{
    public static string Of(JsonNode? node)
    {
        switch (node)
        {
            case null:
                return "null";
            case JsonObject obj:
                var members = obj.OrderBy(p => p.Key, StringComparer.Ordinal)
                    .Select(p => JsonSerializer.Serialize(p.Key) + ":" + Of(p.Value));
                return "{" + string.Join(",", members) + "}";
            case JsonArray arr:
                return "[" + string.Join(",", arr.Select(Of)) + "]";
            case JsonValue value:
                return Scalar(value);
            default:
                return "null";
        }
    }

    public static bool Same(JsonNode? a, JsonNode? b) => Of(a) == Of(b);

    private static string Scalar(JsonValue value)
    {
        var element = JsonSerializer.SerializeToElement(value); // works whether the node holds a parsed element or a .NET value
        return element.ValueKind switch
        {
            JsonValueKind.Number => Number(element),
            JsonValueKind.String => JsonSerializer.Serialize(element.GetString()),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "null"
        };
    }

    // 1, 1.0 and 1e0 are the same number to a reviewer, so they must be the same to the guard.
    private static string Number(JsonElement element)
    {
        if (element.TryGetDecimal(out var d)) return d.ToString("0.#############################", CultureInfo.InvariantCulture);
        return element.GetDouble().ToString("R", CultureInfo.InvariantCulture);
    }
}
