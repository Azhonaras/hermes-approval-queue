using System.Text.Json.Nodes;
using HermesApproval.Core;
using Microsoft.Data.SqlClient;

namespace HermesApproval.Cms;

/// <summary>
/// Demo adapter over a CmsResources table. It shows the shape of a real one: one write path per action verb,
/// executed inside the transaction the store opened, so the content change and the claim commit or roll back together.
/// </summary>
public sealed class SqlCmsAdapter : ICmsAdapter
{
    private readonly string _connectionString;

    public SqlCmsAdapter(string connectionString) => _connectionString = connectionString;

    public async Task<JsonObject?> ReadAsync(int siteId, string resourceType, JsonNode resourceId)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        return await ReadFields(conn, null, siteId, resourceType, StrictJson.ToText(resourceId));
    }

    public async Task<JsonNode?> ApplyAsync(ApplyRequest r)
    {
        if (r.Transaction is not SqlTransaction tx) throw new InvalidOperationException("Expected the store's SqlTransaction.");
        var conn = tx.Connection;
        var rid = StrictJson.ToText(r.ResourceId);
        var verb = r.Action.Split(':')[0];
        var current = await ReadFields(conn, tx, r.SiteId, r.ResourceType, rid) ?? new JsonObject();

        JsonObject? next = verb switch
        {
            "update" => Merge(current, r.Proposal),
            "create" => (JsonObject)r.Proposal.DeepClone(),
            "merge" => Merge(current, new JsonObject { ["mergedInto"] = r.Proposal["into"]?.DeepClone() }),
            "delete" => null,
            _ => throw new InvalidOperationException("No write path for " + r.Action)
        };

        await using var cmd = new SqlCommand(next is null
            ? "DELETE FROM dbo.CmsResources WHERE SiteId=@s AND ResourceType=@t AND ResourceIdJson=@r"
            : @"MERGE dbo.CmsResources AS target
                USING (SELECT @s AS SiteId, @t AS ResourceType, @r AS ResourceIdJson) AS src
                ON target.SiteId = src.SiteId AND target.ResourceType = src.ResourceType AND target.ResourceIdJson = src.ResourceIdJson
                WHEN MATCHED THEN UPDATE SET FieldsJson = @f
                WHEN NOT MATCHED THEN INSERT (SiteId, ResourceType, ResourceIdJson, FieldsJson) VALUES (@s, @t, @r, @f);", conn, tx);
        cmd.Parameters.AddWithValue("@s", r.SiteId);
        cmd.Parameters.AddWithValue("@t", r.ResourceType);
        cmd.Parameters.AddWithValue("@r", rid);
        if (next is not null) cmd.Parameters.AddWithValue("@f", StrictJson.ToText(next));
        await cmd.ExecuteNonQueryAsync();

        // A real CMS validates what it saves. This check runs AFTER the row is written on purpose: a refusal
        // here must roll the whole transaction back, which is exactly what the conformance suite probes.
        if (r.Proposal["canonical"] is JsonValue cv && cv.TryGetValue<string>(out var url) && url != ""
            && !System.Text.RegularExpressions.Regex.IsMatch(url, @"\Ahttps?://\S+\z"))
            throw new InvalidOperationException("canonical must be an absolute http(s) URL");

        return new JsonObject { ["resourceType"] = r.ResourceType, ["resourceId"] = r.ResourceId.DeepClone(), ["fields"] = next };
    }

    private static JsonObject Merge(JsonObject current, JsonObject patch)
    {
        var merged = (JsonObject)current.DeepClone();
        foreach (var (key, value) in patch) merged[key] = value?.DeepClone();
        return merged;
    }

    private static async Task<JsonObject?> ReadFields(SqlConnection conn, SqlTransaction? tx, int siteId, string type, string rid)
    {
        await using var cmd = new SqlCommand(
            "SELECT FieldsJson FROM dbo.CmsResources WHERE SiteId=@s AND ResourceType=@t AND ResourceIdJson=@r", conn, tx);
        cmd.Parameters.AddWithValue("@s", siteId);
        cmd.Parameters.AddWithValue("@t", type);
        cmd.Parameters.AddWithValue("@r", rid);
        return await cmd.ExecuteScalarAsync() is string json ? (JsonObject)JsonNode.Parse(json)! : null;
    }
}
