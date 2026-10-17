using System.Text.Json.Nodes;

namespace HermesApproval.Cms;

public sealed record ApplyRequest(
    long ApprovalId, int SiteId, string ResourceType, JsonNode ResourceId, string Action, JsonObject Proposal,
    /// <summary>The open store transaction (a SqlTransaction for SQL Server). Use it so the content change and the claim commit together.</summary>
    object? Transaction);

/// <summary>
/// The only code that touches your content. Implement both methods on top of your existing save code.
/// Throw from ApplyAsync to fail the write; the approval returns to Approved.
/// Dispatch on Action to exactly one write path.
/// </summary>
public interface ICmsAdapter
{
    Task<JsonObject?> ReadAsync(int siteId, string resourceType, JsonNode resourceId);
    Task<JsonNode?> ApplyAsync(ApplyRequest request);
}
