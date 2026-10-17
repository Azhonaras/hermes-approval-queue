using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using static HermesApproval.Core.ApprovalException;

namespace HermesApproval.Core;

/// <summary>
/// Request-body parsing that matches docs/spec.md on every stack: no duplicate keys, valid Unicode,
/// bounded nesting, and sizes measured on the compact JSON text exactly as a reviewer reads it.
/// </summary>
public static class StrictJson
{
    public const int MaxDepth = 32;

    // Same escaping rules as JavaScript's JSON.stringify: only quotes, backslashes and control characters.
    private static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static JsonNode Parse(ReadOnlySpan<byte> utf8)
    {
        try
        {
            var node = JsonNode.Parse(utf8, null, new JsonDocumentOptions { MaxDepth = MaxDepth })
                       ?? throw Fail("BAD_REQUEST", "Request body must be a JSON object.");
            // JsonNode parses lazily in .NET 8: duplicate keys and invalid UTF-8/UTF-16 only throw when a node is read.
            // Normalize reads every node, so all of them surface here as a 400 instead of a 500 later. It also rebuilds
            // the tree so numbers have one shape on every stack (see Number below).
            return Normalize(node)!;
        }
        catch (ApprovalException) { throw; }
        catch (DecoderFallbackException) { throw Fail("BAD_REQUEST", "Body is not valid UTF-8."); }
        catch (ArgumentException) { throw Fail("BAD_REQUEST", "Body is not acceptable JSON: duplicate key."); }
        catch (JsonException) { throw Fail("BAD_REQUEST", "Body is not valid JSON (or is nested deeper than " + MaxDepth + " levels)."); }
        catch (InvalidOperationException) { throw Fail("BAD_REQUEST", "Body is not acceptable JSON: invalid Unicode."); }
    }

    /// <summary>Length in UTF-16 code units of the compact JSON text (what the "16384 characters" limit counts).</summary>
    public static int CompactLength(JsonNode? node) => node switch
    {
        null => 4,
        JsonObject o => 2 + Math.Max(0, o.Count - 1) + o.Sum(p => TextLength(p.Key) + 1 + CompactLength(p.Value)),
        JsonArray a => 2 + Math.Max(0, a.Count - 1) + a.Sum(CompactLength),
        JsonValue v when v.TryGetValue<string>(out var s) => TextLength(s),
        JsonValue v when v.TryGetValue<bool>(out var b) => b ? 4 : 5,
        JsonValue v when v.TryGetValue<long>(out var l) => l.ToString(CultureInfo.InvariantCulture).Length,
        JsonValue v when v.TryGetValue<double>(out var d) => JsNumber.Text(d).Length,
        _ => node.ToJsonString(Compact).Length,
    };

    // A JSON string as JSON.stringify writes it: two quotes, one unit per character, and escapes only for
    // quotes, backslashes and control characters. (The .NET encoder would write emoji as 12-character escapes.)
    private static int TextLength(string s)
    {
        var n = 2;
        foreach (var ch in s)
            n += ch switch
            {
                '"' or '\\' or '\b' or '\f' or '\n' or '\r' or '\t' => 2,
                < ' ' => 6,
                _ => 1,
            };
        return n;
    }

    public static string ToText(JsonNode node) => node.ToJsonString(Compact);

    private static JsonNode? Normalize(JsonNode? node)
    {
        switch (node)
        {
            case null:
                return null;
            case JsonObject o:
                var copy = new JsonObject();
                foreach (var (key, value) in o) { CheckText(key); copy[key] = Normalize(value); }
                return copy;
            case JsonArray a:
                var list = new JsonArray();
                foreach (var item in a) list.Add(Normalize(item));
                return list;
            default:
                var element = ((JsonValue)node).GetValue<JsonElement>();
                switch (element.ValueKind)
                {
                    case JsonValueKind.String: var text = element.GetString()!; CheckText(text); return JsonValue.Create(text);
                    case JsonValueKind.Number: return Number(element.GetRawText());
                    case JsonValueKind.True: return JsonValue.Create(true);
                    case JsonValueKind.False: return JsonValue.Create(false);
                    default: return null;
                }
        }
    }

    /// <summary>
    /// Numbers are IEEE doubles on every stack. Integer literals beyond ±2^53-1 would silently lose digits elsewhere,
    /// so they are refused (send them as strings); non-finite numbers are refused; a whole number is an integer
    /// whichever way it was written (1, 1.0, 1e0).
    /// </summary>
    private static JsonNode Number(string raw)
    {
        if (raw.IndexOfAny(new[] { '.', 'e', 'E' }) < 0)
        {
            if (!long.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var whole) || Math.Abs(whole) > JsNumber.MaxSafeInteger)
                throw Fail("BAD_REQUEST", "Body is not acceptable JSON: integers beyond ±" + JsNumber.MaxSafeInteger + " must be sent as strings.");
            return JsonValue.Create(whole);
        }
        var d = double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (!double.IsFinite(d)) throw Fail("BAD_REQUEST", "Body is not acceptable JSON: number out of range.");
        return d == Math.Floor(d) && Math.Abs(d) <= JsNumber.MaxSafeInteger ? JsonValue.Create((long)d) : JsonValue.Create(d);
    }

    private static void CheckText(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) { i++; continue; }
            if (char.IsSurrogate(text[i])) throw Fail("BAD_REQUEST", "Body is not acceptable JSON: invalid Unicode (unpaired surrogate).");
        }
    }
}
