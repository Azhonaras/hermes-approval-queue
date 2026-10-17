using System.Text.Json.Nodes;
using HermesApproval.Core;

namespace HermesApproval.Store;

/// <summary>Columns a conditional transition may change. Null means "leave as is".</summary>
public sealed record Patch(
    string Status, string? DecisionReason = null, DateTime? DecidedUtc = null, string? DecidedBy = null,
    JsonObject? Proposal = null, JsonObject? OriginalProposal = null, bool? EditedProposal = null);

public sealed record ConsumeResult(ApprovalRow? Row, JsonNode? Result);

public interface IApprovalStore
{
    Task<ApprovalRow> InsertAsync(NewApproval value);
    Task<ApprovalRow?> GetAsync(long id);
    Task<IReadOnlyList<ApprovalRow>> ListAsync(IReadOnlyCollection<string> statuses);

    /// <summary>Applies the patch only if the row is still in <paramref name="from"/>. Null when someone else got there first.</summary>
    Task<ApprovalRow?> TransitionAsync(long id, string from, Patch patch);

    /// <summary>
    /// Claims an Approved row (Approved -> Consumed) and runs <paramref name="apply"/> in the SAME transaction.
    /// If apply throws, the claim is rolled back and the row is Approved again. Row is null when the claim lost a race.
    /// </summary>
    Task<ConsumeResult> ConsumeAsync(long id, DateTime nowUtc, Func<ApprovalRow, object?, Task<JsonNode?>> apply);
}
