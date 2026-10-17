using System.Text.RegularExpressions;
using System.Text.Json.Nodes;
using HermesApproval.Cms;
using HermesApproval.Core;

namespace HermesApproval.Tests.Support;

/// <summary>
/// The demo CMS in memory, with the same write paths as <c>SqlCmsAdapter</c>. A write is validated before it is stored, so a
/// refused save leaves nothing behind (the SQL adapter gets that from its transaction).
/// </summary>
public sealed class MemoryCmsAdapter : ICmsAdapter
{
    private readonly object _gate = new();
    private readonly Dictionary<string, JsonObject> _resources = new();

    public MemoryCmsAdapter() =>
        _resources[Key(1, "article", JsonValue.Create(42)!)] = new JsonObject { ["title"] = "Sample guide", ["canonical"] = "" };

    private static string Key(int siteId, string type, JsonNode id) => siteId + "|" + type + "|" + StrictJson.ToText(id);

    public Task<JsonObject?> ReadAsync(int siteId, string resourceType, JsonNode resourceId)
    {
        lock (_gate) return Task.FromResult(_resources.TryGetValue(Key(siteId, resourceType, resourceId), out var f) ? (JsonObject)f.DeepClone() : null);
    }

    public Task<JsonNode?> ApplyAsync(ApplyRequest r)
    {
        var key = Key(r.SiteId, r.ResourceType, r.ResourceId);
        var verb = r.Action.Split(':')[0];
        if (verb is not ("update" or "create" or "merge" or "delete")) throw new InvalidOperationException("No write path for " + r.Action);
        if (r.Proposal["canonical"] is JsonValue cv && cv.TryGetValue<string>(out var url) && url != "" && !Regex.IsMatch(url, @"\Ahttps?://\S+\z"))
            throw new InvalidOperationException("canonical must be an absolute http(s) URL");

        lock (_gate)
        {
            _resources.TryGetValue(key, out var current);
            JsonObject? next = verb switch
            {
                "update" => Merge(current ?? new JsonObject(), r.Proposal),
                "create" => (JsonObject)r.Proposal.DeepClone(),
                "merge" => Merge(current ?? new JsonObject(), new JsonObject { ["mergedInto"] = r.Proposal["into"]?.DeepClone() }),
                _ => null
            };
            if (next is null) _resources.Remove(key); else _resources[key] = next;
            return Task.FromResult<JsonNode?>(new JsonObject { ["resourceType"] = r.ResourceType, ["resourceId"] = r.ResourceId.DeepClone(), ["fields"] = next?.DeepClone() });
        }
    }

    private static JsonObject Merge(JsonObject current, JsonObject patch)
    {
        var merged = (JsonObject)current.DeepClone();
        foreach (var (key, value) in patch) merged[key] = value?.DeepClone();
        return merged;
    }
}
