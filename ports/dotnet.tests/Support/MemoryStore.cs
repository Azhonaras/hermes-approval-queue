using System.Text.Json.Nodes;
using HermesApproval.Core;
using HermesApproval.Store;

namespace HermesApproval.Tests.Support;

/// <summary>
/// In-memory <see cref="IApprovalStore"/> for unit tests and for MemoryHost. It keeps the contract that matters to the HTTP
/// layer and the service (every transition is conditional on the current status; a claim is applied once; a failed apply
/// puts the row back to Approved), but it is NOT evidence about SQL transactions: StoreTests with a real SQL Server is.
/// </summary>
public sealed class MemoryStore : IApprovalStore
{
    private sealed class Entry
    {
        public long Id; public int SiteId; public string Type = ""; public JsonNode ResourceId = null!;
        public string Action = "", Scope = "", Status = "", Reason = "";
        public JsonObject Proposal = null!; public JsonObject? Original; public bool Edited;
        public string? DecisionReason; public long? RevisionOf; public DateTime Created, Expires; public DateTime? Decided; public string? DecidedBy;
    }

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<long, Entry> _rows = new();
    private long _last = 1000;

    private static ApprovalRow Map(Entry e) => new()
    {
        ApprovalId = e.Id, SiteId = e.SiteId, ResourceType = e.Type, ResourceId = e.ResourceId.DeepClone(), Action = e.Action, Scope = e.Scope,
        Status = e.Status, Reason = e.Reason, Proposal = (JsonObject)e.Proposal.DeepClone(), OriginalProposal = (JsonObject?)e.Original?.DeepClone(),
        EditedProposal = e.Edited, DecisionReason = e.DecisionReason, RevisionOfApprovalId = e.RevisionOf, CreatedUtc = e.Created,
        DecidedUtc = e.Decided, DecidedBy = e.DecidedBy, ExpiresUtc = e.Expires
    };

    /// <summary>
    /// The same fixture the SQL seed has: approval 1036, Approved, already past its expiry. As in SQL Server after an explicit
    /// IDENTITY_INSERT, new rows then continue after 1036 instead of running into it.
    /// </summary>
    public void SeedExpiredFixture()
    {
        _last = Math.Max(_last, 1036);
        _rows[1036] = new Entry
        {
            Id = 1036, SiteId = 1, Type = "page", ResourceId = JsonValue.Create(77)!, Action = "update:onpage", Scope = "seo:write", Status = Status.Approved,
            Reason = "Approval expired before the agent redeemed it.", Proposal = new JsonObject { ["titleSeo"] = "Expired sample" },
            Created = new DateTime(2020, 1, 1, 9, 0, 0, DateTimeKind.Utc), Decided = new DateTime(2020, 1, 1, 9, 10, 0, DateTimeKind.Utc),
            DecidedBy = "manager.demo", Expires = new DateTime(2020, 1, 2, 9, 0, 0, DateTimeKind.Utc)
        };
    }

    public async Task<ApprovalRow> InsertAsync(NewApproval v)
    {
        await _gate.WaitAsync();
        try
        {
            var e = new Entry
            {
                Id = ++_last, SiteId = v.SiteId, Type = v.ResourceType, ResourceId = v.ResourceId.DeepClone(), Action = v.Action, Scope = v.Scope,
                Status = Status.Pending, Reason = v.Reason, Proposal = (JsonObject)v.Proposal.DeepClone(), RevisionOf = v.RevisionOfApprovalId,
                Created = v.CreatedUtc, Expires = v.ExpiresUtc
            };
            _rows[e.Id] = e;
            return Map(e);
        }
        finally { _gate.Release(); }
    }

    public async Task<ApprovalRow?> GetAsync(long id)
    {
        await _gate.WaitAsync();
        try { return _rows.TryGetValue(id, out var e) ? Map(e) : null; }
        finally { _gate.Release(); }
    }

    public async Task<IReadOnlyList<ApprovalRow>> ListAsync(IReadOnlyCollection<string> statuses)
    {
        await _gate.WaitAsync();
        try { return _rows.Values.Where(e => statuses.Contains(e.Status)).Select(Map).ToList(); }
        finally { _gate.Release(); }
    }

    public async Task<ApprovalRow?> TransitionAsync(long id, string from, Patch p)
    {
        await _gate.WaitAsync();
        try
        {
            if (!_rows.TryGetValue(id, out var e) || e.Status != from) return null;
            e.Status = p.Status;
            if (p.DecisionReason is not null) e.DecisionReason = p.DecisionReason;
            if (p.DecidedUtc is not null) e.Decided = p.DecidedUtc;
            if (p.DecidedBy is not null) e.DecidedBy = p.DecidedBy;
            if (p.Proposal is not null) e.Proposal = (JsonObject)p.Proposal.DeepClone();
            if (p.OriginalProposal is not null) e.Original = (JsonObject)p.OriginalProposal.DeepClone();
            if (p.EditedProposal is not null) e.Edited = p.EditedProposal.Value;
            return Map(e);
        }
        finally { _gate.Release(); }
    }

    public async Task<ConsumeResult> ConsumeAsync(long id, DateTime nowUtc, Func<ApprovalRow, object?, Task<JsonNode?>> apply)
    {
        await _gate.WaitAsync();
        try
        {
            if (!_rows.TryGetValue(id, out var e) || e.Status != Status.Approved) return new ConsumeResult(null, null);
            e.Status = Status.Consumed;
            try { return new ConsumeResult(Map(e), await apply(Map(e), null)); }
            catch { e.Status = Status.Approved; throw; }
        }
        finally { _gate.Release(); }
    }
}
