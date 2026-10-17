using System.Text.Json.Nodes;
using HermesApproval.Cms;
using HermesApproval.Core;
using HermesApproval.Store;
using Microsoft.Data.SqlClient;
using Xunit;

namespace HermesApproval.Tests;

/// <summary>
/// Needs a real SQL Server: set HERMES_TEST_DB to a connection string for an empty, disposable database.
/// Without it every test here is skipped (a mock would not prove transaction behaviour).
/// </summary>
public class StoreTests : IAsyncLifetime
{
    private static readonly string? Db = Environment.GetEnvironmentVariable("HERMES_TEST_DB");
    private SqlServerStore _store = null!;
    private SqlCmsAdapter _real = null!;

    public async Task InitializeAsync()
    {
        if (Db is null) return;
        await Seed.RunAsync(Db);
        _store = new SqlServerStore(Db);
        _real = new SqlCmsAdapter(Db);
    }
    public Task DisposeAsync() => Task.CompletedTask;

    private static JsonObject Obj(string json) => (JsonObject)JsonNode.Parse(json)!;

    private async Task<long> ApprovedRowAsync(JsonObject proposal)
    {
        var row = await _store.InsertAsync(new NewApproval(
            1, "article", JsonValue.Create(42)!, "update:canonical", "seo:write", "test", proposal, null,
            DateTime.UtcNow, DateTime.UtcNow.AddHours(1)));
        var approved = await _store.TransitionAsync(row.ApprovalId, Status.Pending, new Patch(Status.Approved, DecidedUtc: DateTime.UtcNow, DecidedBy: "t"));
        Assert.NotNull(approved);
        return row.ApprovalId;
    }

    private async Task<string> CanonicalNowAsync() => (await _real.ReadAsync(1, "article", JsonValue.Create(42)!))!["canonical"]!.GetValue<string>();

    [SkippableFact]
    public async Task Failed_write_rolls_back_the_claim_and_the_content()
    {
        Skip.If(Db is null, "set HERMES_TEST_DB");
        var before = await CanonicalNowAsync();
        var id = await ApprovedRowAsync(Obj("""{"canonical":"https://example.test/rollback"}"""));

        // Writes the content first, THEN fails: the content change must be undone along with the claim.
        await Assert.ThrowsAsync<InvalidOperationException>(() => _store.ConsumeAsync(id, DateTime.UtcNow, async (row, tx) =>
        {
            await _real.ApplyAsync(new ApplyRequest(row.ApprovalId, row.SiteId, row.ResourceType, row.ResourceId, row.Action, row.Proposal, tx));
            throw new InvalidOperationException("boom after write");
        }));

        Assert.Equal(Status.Approved, (await _store.GetAsync(id))!.Status);
        Assert.Equal(before, await CanonicalNowAsync());

        // ...and it can be redeemed afterwards.
        var ok = await _store.ConsumeAsync(id, DateTime.UtcNow, (row, tx) =>
            _real.ApplyAsync(new ApplyRequest(row.ApprovalId, row.SiteId, row.ResourceType, row.ResourceId, row.Action, row.Proposal, tx)));
        Assert.NotNull(ok.Row);
        Assert.Equal("https://example.test/rollback", await CanonicalNowAsync());
        Assert.Equal(Status.Consumed, (await _store.GetAsync(id))!.Status);
    }

    [SkippableFact]
    public async Task Parallel_claims_apply_exactly_once()
    {
        Skip.If(Db is null, "set HERMES_TEST_DB");
        var id = await ApprovedRowAsync(Obj("""{"canonical":"https://example.test/once"}"""));
        var applied = 0;
        var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => _store.ConsumeAsync(id, DateTime.UtcNow, async (row, tx) =>
        {
            Interlocked.Increment(ref applied);
            await Task.Delay(30);
            return await _real.ApplyAsync(new ApplyRequest(row.ApprovalId, row.SiteId, row.ResourceType, row.ResourceId, row.Action, row.Proposal, tx));
        })));
        Assert.Equal(1, results.Count(r => r.Row is not null));
        Assert.Equal(1, applied);
    }

    [SkippableFact]
    public async Task Audit_row_is_written_in_the_same_transaction()
    {
        Skip.If(Db is null, "set HERMES_TEST_DB");
        var id = await ApprovedRowAsync(Obj("""{"canonical":"https://example.test/audit"}"""));
        await Assert.ThrowsAsync<InvalidOperationException>(() => _store.ConsumeAsync(id, DateTime.UtcNow, (_, _) => throw new InvalidOperationException("x")));
        await using var conn = new SqlConnection(Db);
        await conn.OpenAsync();
        await using var cmd = new SqlCommand("SELECT COUNT(*) FROM dbo.AuditLog WHERE ApprovalId = @id", conn);
        cmd.Parameters.AddWithValue("@id", id);
        Assert.Equal(0, (int)(await cmd.ExecuteScalarAsync())!);
    }
}
