using System.Security.Cryptography;
using System.Text;

namespace HermesApproval.Core;

/// <summary>
/// Decision notifications (docs/spec.md, "Decision notifications"): tells the agent that a person has decided.
/// The service calls <see cref="DecidedAsync"/> once after a decision is stored, without waiting for it, and never lets it
/// undo or fail the decision.
/// </summary>
public interface INotifier
{
    /// <summary>Whether deliveries carry X-Hermes-Timestamp and X-Hermes-Signature; the manifest says so.</summary>
    bool Signed { get; }

    Task DecidedAsync(ApprovalRow row);
}

/// <summary>What a decision notification looks like on the wire, so every notifier builds the same bytes.</summary>
public static class Webhook
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(3);

    /// <summary>The one body a notification has: compact JSON, this key order, no content.</summary>
    public static string Body(ApprovalRow row) =>
        $"{{\"event\":\"decision\",\"approvalId\":{row.ApprovalId},\"status\":\"{row.Status}\",\"decidedUtc\":\"{ApprovalRow.Iso(row.DecidedUtc)}\"}}";

    /// <summary>"sha256=" and the lowercase hex HMAC-SHA256 of "&lt;unix seconds&gt;.&lt;raw body&gt;".</summary>
    public static string Sign(string secret, string timestamp, string body)
    {
        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(timestamp + "." + body));
        return "sha256=" + Convert.ToHexString(mac).ToLowerInvariant();
    }

    /// <summary>Request headers for one delivery. Without a secret there is no proof of origin, so no timestamp or signature.</summary>
    public static Dictionary<string, string> Headers(string secret, string body, DateTimeOffset? now = null)
    {
        var headers = new Dictionary<string, string> { ["X-Hermes-Delivery"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() };
        if (secret != "")
        {
            var timestamp = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
            headers["X-Hermes-Timestamp"] = timestamp;
            headers["X-Hermes-Signature"] = Sign(secret, timestamp, body);
        }
        return headers;
    }

    /// <summary>The receiver is where the operator said: http or https, and no user name or password in the URL.</summary>
    public static bool IsValidUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps) && u.UserInfo == "" && u.Host != "";
}
