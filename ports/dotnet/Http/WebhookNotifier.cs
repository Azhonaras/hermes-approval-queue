using System.Text;
using HermesApproval.Core;

namespace HermesApproval.Http;

/// <summary>
/// Posts each decision to the receiver the operator configured (HERMES_WEBHOOK_URL / HERMES_WEBHOOK_SECRET), never one
/// the agent chose. At most once, 3 seconds at most, no retry, redirects not followed, every failure logged and swallowed.
/// </summary>
public sealed class WebhookNotifier : INotifier
{
    private readonly HttpClient _http;
    private readonly Uri _url;
    private readonly string _secret;
    private readonly ILogger? _log;

    /// <param name="handler">Only tests pass one. The default does not follow redirects.</param>
    public WebhookNotifier(string url, string secret = "", ILogger? log = null, HttpMessageHandler? handler = null)
    {
        if (!Webhook.IsValidUrl(url)) throw new ArgumentException("The webhook url must be a plain http or https URL without a user name or password.", nameof(url));
        _url = new Uri(url);
        _secret = secret;
        _log = log;
        _http = new HttpClient(handler ?? new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = Webhook.Timeout, UseProxy = false })
        {
            Timeout = Webhook.Timeout
        };
    }

    public bool Signed => _secret != "";

    public async Task DecidedAsync(ApprovalRow row)
    {
        try
        {
            var body = Webhook.Body(row);
            using var request = new HttpRequestMessage(HttpMethod.Post, _url) { Content = new StringContent(body, new UTF8Encoding(false), "application/json") };
            foreach (var (name, value) in Webhook.Headers(_secret, body)) request.Headers.TryAddWithoutValidation(name, value);
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            if ((int)response.StatusCode >= 400) _log?.LogWarning("HRM-{Id}: the receiver answered {Status}", row.ApprovalId, (int)response.StatusCode);
        }
        catch (Exception ex)
        {
            try { _log?.LogWarning("HRM-{Id}: notification not delivered ({Why})", row.ApprovalId, ex is TaskCanceledException ? "timeout" : ex.GetType().Name); }
            catch { /* a broken logger must not matter */ }
        }
    }
}
