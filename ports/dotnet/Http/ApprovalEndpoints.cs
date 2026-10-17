using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using HermesApproval.Core;
using static HermesApproval.Core.ApprovalException;

namespace HermesApproval.Http;

/// <summary>Route table: method + path -> door check -> service call, wrapped in the spec's JSON envelope.</summary>
public static class ApprovalEndpoints
{
    private const int MaxBodyBytes = 200_000;
    private static readonly Regex Decide = new(@"\A/proposals/([0-9]+)/(approve|reject|request-changes)\z", RegexOptions.Compiled);
    private static readonly Regex One = new(@"\A/proposals/([0-9]+)\z", RegexOptions.Compiled);
    private static readonly Regex Resource = new(@"\A/resources/([^/]+)/([^/]+)\z", RegexOptions.Compiled);

    public static WebApplication MapApprovalApi(this WebApplication app, string basePath, ApprovalService service, IDoors doors, string? corsOrigin)
    {
        basePath = basePath.TrimEnd('/');
        app.Use(async (context, next) =>
        {
            // Match on the raw request target (still percent-encoded): segments must be split on "/" first and decoded once after.
            var target = context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpRequestFeature>()?.RawTarget ?? context.Request.Path.Value ?? "";
            var parts = target.Split('?', 2);
            var path = parts[0];
            if (path != basePath && !path.StartsWith(basePath + "/", StringComparison.Ordinal)) { await next(); return; }
            await Handle(context, path[basePath.Length..] is { Length: > 0 } rel ? rel : "/", parts.Length > 1 ? parts[1] : "", basePath, service, doors, corsOrigin);
        });
        return app;
    }

    private static async Task Handle(HttpContext c, string path, string rawQuery, string basePath, ApprovalService service, IDoors doors, string? cors)
    {
        if (cors is not null)
        {
            c.Response.Headers["Access-Control-Allow-Origin"] = cors;
            c.Response.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Api-Key, X-Review-Session";
            c.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        }
        if (c.Request.Method == "OPTIONS") { c.Response.StatusCode = 204; return; }

        try
        {
            var agent = doors.Agent(c);
            var reviewer = doors.Reviewer(c);
            var data = await Route(c, path, rawQuery, basePath, service, agent, reviewer);
            await Write(c, 200, new JsonObject { ["success"] = true, ["data"] = data });
        }
        catch (ApprovalException e)
        {
            await Write(c, e.HttpStatus, Error(e.Code, e.Message));
        }
        catch (Exception e)
        {
            c.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Hermes").LogError(e, "Unhandled error");
            await Write(c, 500, Error("INTERNAL", "Unexpected server error."));
        }
    }

    private static async Task<JsonNode?> Route(HttpContext c, string path, string rawQuery, string basePath, ApprovalService svc, AgentIdentity agent, Reviewer? reviewer)
    {
        var method = c.Request.Method;
        bool Is(string m, string p) => method == m && path == p;
        // NUL is valid UTF-8, but some servers (Kestrel, IIS) refuse %00 before we run; the contract says 400 everywhere.
        if (path.Contains("%00", StringComparison.Ordinal)) throw Fail("BAD_REQUEST", "A path may not contain a NUL character.");

        if (Is("GET", "/ping")) return new JsonObject { ["ok"] = true, ["utc"] = ApprovalRow.Iso(svc.Now) };

        if (Is("GET", "/manifest"))
        {
            NeedRead(agent, reviewer);
            var manifest = new JsonObject
            {
                ["version"] = "2.0", ["baseUrl"] = basePath, ["authHeader"] = "X-Api-Key",
                ["actions"] = new JsonArray(svc.Profile.Actions.Select(a => (JsonNode)a).ToArray()),
                ["scopes"] = new JsonArray(svc.Profile.Scopes.Select(a => (JsonNode)a).ToArray()),
                ["approvalLifecycle"] = new JsonArray(Status.Lifecycle.Select(a => (JsonNode)a).ToArray()),
                ["limits"] = new JsonObject
                {
                    ["maxFields"] = svc.Profile.MaxFields, ["maxJsonChars"] = svc.Profile.MaxJsonChars, ["maxReasonChars"] = svc.Profile.MaxReasonChars
                }
            };
            if (svc.Notifications is { } notifications) manifest["notifications"] = notifications;   // optional in the spec
            return manifest;
        }

        if (method == "GET" && Resource.Match(path) is { Success: true } rm)
        {
            NeedRead(agent, reviewer);
            var rawSite = QueryValue(rawQuery, "siteId");
            if (rawSite is not null && !SiteQuery.IsMatch(rawSite)) throw Fail("BAD_REQUEST", "siteId must be a positive integer.");
            var siteId = rawSite is null ? 1 : int.Parse(rawSite, NumberStyles.None, CultureInfo.InvariantCulture);
            return await svc.ReadResourceAsync(siteId, Decode(rm.Groups[1].Value), PathId(Decode(rm.Groups[2].Value)));
        }

        if (Is("GET", "/proposals"))
        {
            if (reviewer is null) throw Fail("SCOPE_DENIED", "Listing is a review-door call.");
            var status = QueryValue(rawQuery, "status");
            var rows = await svc.ListAsync(string.IsNullOrEmpty(status) ? "pending" : AsciiLower(status));   // ASCII only: İ must not become i
            return new JsonArray(rows.Select(r => (JsonNode)r.ToDto()).ToArray());
        }

        if (method == "GET" && One.Match(path) is { Success: true } om)
        {
            NeedRead(agent, reviewer);
            return (await svc.GetAsync(Id(om.Groups[1].Value))).ToDto();
        }

        if (Is("POST", "/proposals"))
        {
            if (!agent.Write) throw Fail("SCOPE_DENIED", "Submit requires the write key.");
            return (await svc.SubmitAsync(await ReadBody(c))).ToDto();
        }

        if (method == "POST" && Decide.Match(path) is { Success: true } dm)
        {
            if (agent.Write) throw Fail("SCOPE_DENIED", "The write key cannot approve.");
            if (reviewer is null) throw Fail("SCOPE_DENIED", "Decide requires a review session.");
            var body = (JsonObject)(await ReadBody(c))!;
            var row = await svc.DecideAsync(Id(dm.Groups[1].Value), dm.Groups[2].Value, reviewer, body["reason"], body.ContainsKey("proposal"), body["proposal"]);
            return row.ToDto();
        }

        if (Is("POST", "/writes"))
        {
            if (!agent.Write) throw Fail("SCOPE_DENIED", "Writes require the write key.");
            return await svc.ExecuteAsync(await ReadBody(c));
        }

        throw Fail("NOT_FOUND", "No such route.");
    }

    // \A and \z, never ^ and $: in .NET "$" also matches before a final newline, so "42\n" was read as the number 42 and a siteId of "1\n" as 1.
    private static readonly Regex SiteQuery = new(@"\A[1-9][0-9]{0,8}\z", RegexOptions.Compiled);
    private static readonly Regex CanonicalInteger = new(@"\A(0|-?[1-9][0-9]{0,14})\z", RegexOptions.Compiled);

    /// <summary>
    /// The first value of a query parameter, by exact (case-sensitive) name, read from the raw query string. ASP.NET's own
    /// Request.Query matches names case-insensitively, so "?SITEID=abc" would have been a 400 here and ignored by the other stacks.
    /// </summary>
    private static string? QueryValue(string rawQuery, string name)
    {
        foreach (var pair in rawQuery.Split('&'))
        {
            if (pair.Length == 0) continue;
            var eq = pair.IndexOf('=');
            if (UnescapeQuery(eq < 0 ? pair : pair[..eq]) != name) continue;
            return eq < 0 ? "" : UnescapeQuery(pair[(eq + 1)..]);
        }
        return null;
    }

    private static string UnescapeQuery(string s) => Uri.UnescapeDataString(s.Replace('+', ' '));

    private static string AsciiLower(string s) => string.Create(s.Length, s, (span, src) =>
    {
        for (var i = 0; i < src.Length; i++) span[i] = src[i] is >= 'A' and <= 'Z' ? (char)(src[i] + 32) : src[i];
    });

    /// <summary>
    /// Path segments are percent-decoded exactly once, after the path was split on "/". A malformed escape (%zz, a lone %)
    /// or bytes that are not UTF-8 after decoding are a 400. (Uri.UnescapeDataString would leave those silently undecoded.)
    /// </summary>
    private static string Decode(string segment)
    {
        var raw = Encoding.UTF8.GetBytes(segment);
        var bytes = new List<byte>(raw.Length);
        for (var i = 0; i < raw.Length; i++)
        {
            if (raw[i] != (byte)'%') { bytes.Add(raw[i]); continue; }
            if (i + 2 >= raw.Length || !Uri.IsHexDigit((char)raw[i + 1]) || !Uri.IsHexDigit((char)raw[i + 2]))
                throw Fail("BAD_REQUEST", "Malformed percent-encoding in the path.");
            bytes.Add(Convert.ToByte(((char)raw[i + 1]).ToString() + (char)raw[i + 2], 16));
            i += 2;
        }
        string decoded;
        try { decoded = new UTF8Encoding(false, true).GetString(bytes.ToArray()); }
        catch (DecoderFallbackException) { throw Fail("BAD_REQUEST", "Path is not valid UTF-8 after percent-decoding."); }
        if (decoded.Contains('\0')) throw Fail("BAD_REQUEST", "A path segment may not contain a NUL character.");
        return decoded;
    }

    /// <summary>A path segment that is a canonical integer is that number; anything else (007, +5, 4.0, abc) is a string.</summary>
    private static JsonNode PathId(string segment) =>
        CanonicalInteger.IsMatch(segment) ? JsonValue.Create(long.Parse(segment, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture))! : JsonValue.Create(segment)!;

    /// <summary>An id too large for a long cannot exist, so it is "not found", not a server error.</summary>
    private static long Id(string digits) => long.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : throw Fail("NOT_FOUND", "No proposal with that id.");

    private static void NeedRead(AgentIdentity agent, Reviewer? reviewer)
    {
        if (!agent.Read && reviewer is null) throw Fail("UNAUTHORIZED", "Read key or review session required.");
    }

    /// <summary>UTF-8 JSON body with a size cap. Empty body is an empty object.</summary>
    private static async Task<JsonNode?> ReadBody(HttpContext c)
    {
        // Content-Type must be application/json (also for an empty body); no Content-Type is fine only for an empty body.
        // Otherwise a page on another site could send a JSON body as a "simple" cross-origin request (text/plain), which a browser sends without asking first.
        var type = c.Request.Headers.ContentType.Count == 0 ? null : c.Request.Headers.ContentType.ToString();
        if (type is not null && !IsJsonMediaType(type)) throw Fail("UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.");
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        var total = 0;
        int read;
        while ((read = await c.Request.Body.ReadAsync(chunk)) > 0)
        {
            total += read;
            if (total <= MaxBodyBytes) buffer.Write(chunk, 0, read);   // keep draining so the client can read our 413
        }
        if (total > MaxBodyBytes) throw Fail("PAYLOAD_TOO_LARGE", "Request body is too large.");
        if (type is null && total > 0) throw Fail("UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.");
        if (buffer.Length == 0) return new JsonObject();
        return StrictJson.Parse(buffer.ToArray()) as JsonObject ?? throw Fail("BAD_REQUEST", "Request body must be a JSON object.");
    }

    /// <summary>The media type is application/json whatever its parameters or case ("application/json; charset=utf-8").</summary>
    private static bool IsJsonMediaType(string value) => value.Split(';')[0].Trim(' ', '\t').Equals("application/json", StringComparison.OrdinalIgnoreCase);

    private static JsonObject Error(string code, string message) =>
        new() { ["success"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

    private static async Task Write(HttpContext c, int status, JsonObject body)
    {
        c.Response.StatusCode = status;
        c.Response.ContentType = "application/json; charset=utf-8";
        await c.Response.WriteAsync(body.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
    }
}
