using System.Text.Json.Nodes;
using static HermesApproval.Core.ApprovalException;

namespace HermesApproval.Core;

public sealed record Submission(
    int SiteId, string ResourceType, JsonNode ResourceId, string Action, string Scope, string Reason,
    JsonObject Proposal, long? RevisionOfApprovalId);

/// <summary>Pure checks on what the agent submits and what a reviewer edits. No I/O.</summary>
public static class Validation
{
    public const int MaxResourceTypeChars = 100, MaxResourceIdChars = 200;

    // JavaScript's String.prototype.trim() set, so "the same string" is trimmed the same way on every stack.
    // (.NET's own Trim() keeps U+FEFF and strips U+0085, which would store two different resource types for one request.)
    private static readonly char[] JsWhitespace = "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF".ToCharArray();

    public static string Trim(string s) => s.Trim(JsWhitespace);

    public static JsonObject AssertReviewable(JsonNode? proposal, Profile profile, bool allowEmpty)
    {
        if (proposal is not JsonObject obj) throw Fail("BAD_REQUEST", "proposal must be a JSON object.");
        if (obj.Count == 0 && !allowEmpty) throw Fail("BAD_REQUEST", "proposal is required.");
        if (obj.Count > profile.MaxFields) throw Fail("BAD_REQUEST", "Too many proposal fields.");
        if (StrictJson.CompactLength(obj) > profile.MaxJsonChars) throw Fail("BAD_REQUEST", "Proposal is too large to review.");
        return obj;
    }

    /// <summary>A whole number, however it was written (the parser already turned 1.0 and 1e0 into 1).</summary>
    public static bool IsInteger(JsonNode? node, out long value)
    {
        value = 0;
        return node is JsonValue v && v.TryGetValue<long>(out value);
    }

    public static bool IsString(JsonNode? node, out string value)
    {
        value = "";
        return node is JsonValue v && v.TryGetValue<string>(out value!);
    }

    /// <summary>A resource id is a string or a number. Objects, arrays, booleans and over-long values are refused.</summary>
    public static void AssertResourceId(JsonNode? id)
    {
        if (id is null || (IsString(id, out var s) && s == "")) throw Fail("BAD_REQUEST", "resourceType and resourceId are required.");
        var ok = IsString(id, out _) || IsInteger(id, out _) || (id is JsonValue v && v.TryGetValue<double>(out _));
        if (!ok) throw Fail("BAD_REQUEST", "resourceId must be a string or a number.");
        // The store's identifier columns are this wide; refuse longer values here instead of failing in the database.
        if (StrictJson.CompactLength(id) > MaxResourceIdChars) throw Fail("BAD_REQUEST", "resourceId is too long.");
    }

    public static Submission ValidateSubmission(JsonNode? body, Profile profile)
    {
        if (body is not JsonObject o) throw Fail("BAD_REQUEST", "Request body must be a JSON object.");

        var resourceType = IsString(o["resourceType"], out var rt) ? Trim(rt) : "";
        if (resourceType == "") throw Fail("BAD_REQUEST", "resourceType and resourceId are required.");
        if (resourceType.Length > MaxResourceTypeChars) throw Fail("BAD_REQUEST", "resourceType is too long.");
        var resourceId = o["resourceId"];
        AssertResourceId(resourceId);

        if (!IsString(o["action"], out var action) || !IsString(o["scope"], out var scope))
            throw Fail("BAD_REQUEST", "action and scope must be strings.");
        if (!profile.Actions.Contains(action)) throw Fail("BAD_REQUEST", "Unknown action.");
        if (!profile.Scopes.Contains(scope)) throw Fail("BAD_REQUEST", "Unknown scope.");

        var proposal = AssertReviewable(o["proposal"], profile, Profile.IsDelete(action));

        var reason = "";
        if (o["reason"] is { } reasonNode)
        {
            if (!IsString(reasonNode, out reason)) throw Fail("BAD_REQUEST", "reason must be a string.");
            if (reason.Length > profile.MaxReasonChars) throw Fail("BAD_REQUEST", "reason is too long.");
        }

        var siteId = 1;
        if (o.ContainsKey("siteId"))
        {
            if (!IsInteger(o["siteId"], out var sid) || sid < 1 || sid > 999_999_999) throw Fail("BAD_REQUEST", "siteId must be an integer from 1 to 999999999.");
            siteId = (int)sid;
        }

        long? revision = null;
        if (o["revisionOfApprovalId"] is { } rv)
        {
            if (!IsInteger(rv, out var rid)) throw Fail("BAD_REQUEST", "revisionOfApprovalId must be an integer.");
            if (rid != 0) revision = rid;
        }

        return new Submission(siteId, resourceType, resourceId!.DeepClone(), action, scope, reason, proposal, revision);
    }

    /// <summary>A revision may change the reason and the proposal only.</summary>
    public static void AssertRevisionMatches(ApprovalRow parent, Submission s)
    {
        if (parent.SiteId != s.SiteId || parent.ResourceType != s.ResourceType || !Canonical.Same(parent.ResourceId, s.ResourceId)
            || parent.Action != s.Action || parent.Scope != s.Scope)
            throw Fail("REVISION_MISMATCH", "Revision must keep the parent site, resource, action, and scope.");
    }
}
