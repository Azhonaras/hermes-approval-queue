using System.Text.Json.Nodes;
using HermesApproval.Core;
using HermesApproval.Tests.Support;
using Xunit;

namespace HermesApproval.Tests;

/// <summary>The in-memory store behind MemoryHost keeps the one habit of the SQL store the conformance suite leans on.</summary>
public class MemoryStoreTests
{
    [Fact]
    public async Task New_rows_continue_after_the_seeded_expired_fixture_instead_of_replacing_it()
    {
        var store = new MemoryStore();
        store.SeedExpiredFixture();
        var now = DateTime.UtcNow;
        for (var i = 0; i < 60; i++)
            await store.InsertAsync(new NewApproval(1, "post", JsonValue.Create(42)!, "update:canonical", "seo:write", "r", new JsonObject(), null, now, now.AddDays(1)));

        var fixture = await store.GetAsync(1036);
        Assert.NotNull(fixture);
        Assert.Equal(Status.Approved, fixture!.Status);
        Assert.Equal("page", fixture.ResourceType);
        Assert.Equal(new DateTime(2020, 1, 2, 9, 0, 0, DateTimeKind.Utc), fixture.ExpiresUtc);
        Assert.Equal(61, (await store.ListAsync(new[] { Status.Pending, Status.Approved })).Count);
    }
}
