using System.Text.Json.Nodes;
using HermesApproval.Cms;
using HermesApproval.Store;
using static HermesApproval.Core.ApprovalException;

namespace HermesApproval.Core;

public sealed record Reviewer(string Id);

/// <summary>Every use case of the approval queue, independent of HTTP. Dependencies are injected.</summary>
public sealed class ApprovalService
{
    private readonly IApprovalStore _store;
    private readonly ICmsAdapter _cms;
    private readonly Profile _profile;
    private readonly Func<DateTime> _clock;
    private readonly TimeSpan _ttl;
    private readonly INotifier? _notifier;

    public ApprovalService(IApprovalStore store, ICmsAdapter cms, Profile profile, Func<DateTime>? clock = null, TimeSpan? ttl = null, INotifier? notifier = null)
    {
        _store = store; _cms = cms; _profile = profile;
        _clock = clock ?? (() => DateTime.UtcNow);
        _ttl = ttl ?? TimeSpan.FromHours(24);
        _notifier = notifier;
    }

    public Profile Profile => _profile;
    public DateTime Now => _clock();

    /// <summary>What the manifest says about notifications; null when there is no notifier.</summary>
    public JsonObject? Notifications => _notifier is null ? null : new JsonObject { ["decision"] = true, ["signed"] = _notifier.Signed };

    /// <summary>After the decision is stored, without waiting: the reviewer's answer must not depend on the agent's server.</summary>
    private void Announce(ApprovalRow row)
    {
        if (_notifier is null) return;
        _ = Task.Run(async () =>
        {
            try { await _notifier.DecidedAsync(row); }
            catch { /* a failing notifier never undoes a decision */ }
        });
    }

    private async Task<ApprovalRow?> ExpireIfDue(ApprovalRow? row)
    {
        if (row is null || !Status.Expirable.Contains(row.Status) || !Guard.IsExpired(row, _clock())) return row;
        return await _store.TransitionAsync(row.ApprovalId, row.Status, new Patch(Status.Expired, DecidedUtc: _clock()))
               ?? await _store.GetAsync(row.ApprovalId);
    }

    public async Task<ApprovalRow> GetAsync(long id)
    {
        var row = await ExpireIfDue(await _store.GetAsync(id));
        return row ?? throw Fail("NOT_FOUND", "No proposal with that id.");
    }

    public async Task<ApprovalRow> SubmitAsync(JsonNode? body)
    {
        var s = Validation.ValidateSubmission(body, _profile);
        if (s.RevisionOfApprovalId is long parentId)
        {
            var parent = await _store.GetAsync(parentId) ?? throw Fail("NOT_FOUND", "Parent proposal does not exist.");
            if (parent.Status != Status.ChangesRequested) throw Fail("REVISION_NOT_REQUESTED", "Parent is not waiting for a revision.");
            Validation.AssertRevisionMatches(parent, s);
        }
        var now = _clock();
        return await _store.InsertAsync(new NewApproval(s.SiteId, s.ResourceType, s.ResourceId, s.Action, s.Scope, s.Reason,
            s.Proposal, s.RevisionOfApprovalId, now, now + _ttl));
    }

    public async Task<IReadOnlyList<ApprovalRow>> ListAsync(string kind)
    {
        var wanted = kind switch
        {
            "pending" => new[] { Status.Pending },
            "history" => Status.History,
            _ => throw Fail("BAD_REQUEST", "status must be pending or history.")
        };
        var rows = new List<ApprovalRow>();
        foreach (var row in await _store.ListAsync(Status.Expirable.Concat(wanted).Distinct().ToArray()))
            if (await ExpireIfDue(row) is { } fresh && wanted.Contains(fresh.Status)) rows.Add(fresh);
        return rows.OrderByDescending(r => r.DecidedUtc ?? r.CreatedUtc).ToList();
    }

    /// <summary>Human decision. On approve, <paramref name="editedProposal"/> replaces the agent's JSON.</summary>
    public async Task<ApprovalRow> DecideAsync(long id, string verb, Reviewer? reviewer, JsonNode? reasonNode, bool hasProposal, JsonNode? editedProposal)
    {
        var target = Status.ForDecision(verb) ?? throw Fail("BAD_REQUEST", "Unknown decision.");
        if (reviewer is null || string.IsNullOrEmpty(reviewer.Id)) throw Fail("SCOPE_DENIED", "Decide requires a review session.");
        string? reason = null;
        if (reasonNode is not null)
        {
            if (!Validation.IsString(reasonNode, out var text)) throw Fail("BAD_REQUEST", "reason must be a string.");
            if (text.Length > _profile.MaxReasonChars) throw Fail("BAD_REQUEST", "reason is too long.");
            reason = text;
        }
        var row = await GetAsync(id);
        if (row.Status != Status.Pending) throw Fail("APPROVAL_NOT_PENDING", $"Proposal is {row.Status} and cannot be decided.");
        var note = Validation.Trim(reason ?? "");
        if (target != Status.Approved && note == "") throw Fail("DECISION_REASON_REQUIRED", "A reason is required.");
        if (hasProposal && target != Status.Approved) throw Fail("BAD_REQUEST", "Only approve can carry an edited proposal.");

        JsonObject? replacement = null;
        if (hasProposal && !Canonical.Same(editedProposal, row.Proposal))
            replacement = Validation.AssertReviewable(editedProposal?.DeepClone(), _profile, Profile.IsDelete(row.Action));

        var patch = new Patch(target, DecisionReason: note == "" ? null : note, DecidedUtc: _clock(), DecidedBy: reviewer.Id,
            Proposal: replacement, OriginalProposal: replacement is null ? null : row.Proposal, EditedProposal: replacement is null ? null : true);
        var updated = await _store.TransitionAsync(row.ApprovalId, Status.Pending, patch)
                      ?? throw Fail("APPROVAL_NOT_PENDING", "Proposal was decided by someone else.");
        Announce(updated);
        return updated;
    }

    /// <summary>Bind, claim once, apply through the CMS adapter. Claim and write share one transaction.</summary>
    public async Task<JsonObject> ExecuteAsync(JsonNode? writeNode)
    {
        if (writeNode is not JsonObject write) throw Fail("BAD_REQUEST", "Request body must be a JSON object.");
        if (!Validation.IsInteger(write["approvalId"], out var id)) throw Fail("BAD_REQUEST", "approvalId must be an integer.");

        var row = await GetAsync(id);
        Guard.AssertBound(row, write, _clock());

        ConsumeResult consumed;
        try
        {
            consumed = await _store.ConsumeAsync(row.ApprovalId, _clock(), (claimed, tx) =>
                _cms.ApplyAsync(new ApplyRequest(claimed.ApprovalId, claimed.SiteId, claimed.ResourceType, claimed.ResourceId,
                    claimed.Action, claimed.Proposal, tx)));
        }
        catch (ApprovalException) { throw; }
        catch (Exception ex)
        {
            throw Fail("WRITE_FAILED", "The CMS rejected the write: " + ex.Message);
        }
        if (consumed.Row is null) throw Fail("APPROVAL_NOT_USABLE", "Approval was already used.");

        return new JsonObject
        {
            ["auditId"] = row.ApprovalId, ["status"] = Status.Consumed, ["resourceType"] = row.ResourceType,
            ["resourceId"] = row.ResourceId.DeepClone(), ["action"] = row.Action, ["result"] = consumed.Result
        };
    }

    public async Task<JsonObject> ReadResourceAsync(int siteId, string resourceType, JsonNode resourceId) =>
        await _cms.ReadAsync(siteId, resourceType, resourceId) ?? throw Fail("NOT_FOUND", "No such resource.");
}
