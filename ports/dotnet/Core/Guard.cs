using System.Text.Json.Nodes;
using static HermesApproval.Core.ApprovalException;

namespace HermesApproval.Core;

/// <summary>
/// The write-path guard. An approval is a capability for one exact request:
/// same resource, action, scope and canonical JSON, redeemable once.
/// </summary>
public static class Guard
{
    public static bool IsExpired(ApprovalRow row, DateTime nowUtc) => row.ExpiresUtc < nowUtc;

    public static void AssertBound(ApprovalRow row, JsonObject write, DateTime nowUtc)
    {
        if (row.Status == Status.Pending) throw Fail("APPROVAL_PENDING", "Not approved yet.");
        if (row.Status == Status.Expired) throw Fail("APPROVAL_EXPIRED", "Approval expired.");
        if (row.Status != Status.Approved) throw Fail("APPROVAL_NOT_USABLE", "Proposal is " + row.Status + ".");
        if (IsExpired(row, nowUtc)) throw Fail("APPROVAL_EXPIRED", "Approval expired.");

        var siteOk = !write.ContainsKey("siteId") || (Validation.IsInteger(write["siteId"], out var site) && site == row.SiteId);
        var same = siteOk
            && Validation.IsString(write["resourceType"], out var type) && type == row.ResourceType
            && write.ContainsKey("resourceId") && Canonical.Same(write["resourceId"], row.ResourceId)
            && Validation.IsString(write["action"], out var action) && action == row.Action
            && Validation.IsString(write["scope"], out var scope) && scope == row.Scope;
        if (!same) throw Fail("APPROVAL_MISMATCH", "Resource, action, or scope does not match.");

        // Absent or null means "no proposal" ({}); anything else is compared as it is, so false or 0 never pass for {}.
        if (!Canonical.Same(write["proposal"] ?? new JsonObject(), row.Proposal))
            throw Fail("APPROVAL_PAYLOAD_MISMATCH", "Body does not match the approved JSON.");
    }
}
