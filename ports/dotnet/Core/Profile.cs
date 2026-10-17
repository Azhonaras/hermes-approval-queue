namespace HermesApproval.Core;

/// <summary>Your CMS vocabulary: which actions and scopes exist, and how big a reviewable proposal may be.</summary>
public sealed record Profile(
    IReadOnlyList<string> Actions,
    IReadOnlyList<string> Scopes,
    int MaxFields = 40,
    int MaxJsonChars = 16384,
    int MaxReasonChars = 1024)
{
    public static bool IsDelete(string action) => action.StartsWith("delete:", StringComparison.Ordinal);

    /// <summary>The example SEO profile the Node demo uses; swap for your own verbs.</summary>
    public static Profile Seo() => new(
        new[]
        {
            "update:onpage", "update:canonical", "update:redirect", "update:schema", "update:indexing", "update:contentlinks",
            "create:taxonomy", "update:taxonomy", "delete:taxonomy", "merge:taxonomy"
        },
        new[] { "seo:write", "content:update", "schema:manage" });
}
