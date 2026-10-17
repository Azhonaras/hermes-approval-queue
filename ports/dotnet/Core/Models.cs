using System.Text.Json.Nodes;

namespace HermesApproval.Core;

public static class Status
{
    public const string Pending = "Pending", Approved = "Approved", Rejected = "Rejected",
        ChangesRequested = "ChangesRequested", Consumed = "Consumed", Expired = "Expired";

    public static readonly string[] Lifecycle = { Pending, Approved, Rejected, ChangesRequested, Consumed, Expired };
    /// <summary>History keeps Approved visible until the agent consumes it.</summary>
    public static readonly string[] History = { Approved, Rejected, Consumed, ChangesRequested, Expired };
    public static readonly string[] Expirable = { Pending, Approved };

    public static string? ForDecision(string verb) => verb switch
    {
        "approve" => Approved, "reject" => Rejected, "request-changes" => ChangesRequested, _ => null
    };
}

public sealed class ApprovalRow
{
    public long ApprovalId { get; init; }
    public int SiteId { get; init; }
    public string ResourceType { get; init; } = "";
    public JsonNode ResourceId { get; init; } = JsonValue.Create(0)!;
    public string Action { get; init; } = "";
    public string Scope { get; init; } = "";
    public string Status { get; init; } = "";
    public string Reason { get; init; } = "";
    public JsonObject Proposal { get; init; } = new();
    public JsonObject? OriginalProposal { get; init; }
    public bool EditedProposal { get; init; }
    public string? DecisionReason { get; init; }
    public long? RevisionOfApprovalId { get; init; }
    public DateTime CreatedUtc { get; init; }
    public DateTime? DecidedUtc { get; init; }
    public string? DecidedBy { get; init; }
    public DateTime ExpiresUtc { get; init; }

    /// <summary>The DTO from docs/spec.md.</summary>
    public JsonObject ToDto() => new()
    {
        ["approvalId"] = ApprovalId, ["siteId"] = SiteId, ["resourceType"] = ResourceType,
        ["resourceId"] = ResourceId.DeepClone(), ["action"] = Action, ["scope"] = Scope, ["status"] = Status,
        ["reason"] = Reason, ["proposal"] = Proposal.DeepClone(), ["decisionReason"] = DecisionReason,
        ["revisionOfApprovalId"] = RevisionOfApprovalId, ["createdUtc"] = Iso(CreatedUtc), ["decidedUtc"] = Iso(DecidedUtc),
        ["decidedBy"] = DecidedBy, ["expiresUtc"] = Iso(ExpiresUtc), ["editedProposal"] = EditedProposal,
        ["originalProposal"] = OriginalProposal?.DeepClone()
    };

    public static string? Iso(DateTime? value) =>
        value?.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
}

public sealed record NewApproval(
    int SiteId, string ResourceType, JsonNode ResourceId, string Action, string Scope, string Reason,
    JsonObject Proposal, long? RevisionOfApprovalId, DateTime CreatedUtc, DateTime ExpiresUtc);
