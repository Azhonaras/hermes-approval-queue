using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using HermesApproval.Core;
using HermesApproval.Http;
using HermesApproval.Tests.Support;
using Xunit;

namespace HermesApproval.Tests;

/// <summary>
/// Decision notifications (docs/spec.md, "Decision notifications") on the .NET port. No SQL Server needed: the service runs on
/// the in-memory store, and the sender talks to a local HttpListener. The conformance suite's `notify` group
/// (node conformance/run.mjs ... --only notify, against ports/dotnet.tests/MemoryHost or the real host) is the black-box check.
/// </summary>
public class NotifyTests
{
    private static ApprovalRow Row() => new()
    {
        ApprovalId = 1042, Status = Status.Approved, DecidedUtc = new DateTime(2026, 10, 16, 1, 40, 12, 345, DateTimeKind.Utc),
        Proposal = new JsonObject { ["secret"] = "must not leak" }
    };

    private const string WireBody = "{\"event\":\"decision\",\"approvalId\":1042,\"status\":\"Approved\",\"decidedUtc\":\"2026-10-16T01:40:12.345Z\"}";

    [Fact]
    public void The_body_is_compact_json_with_four_fields_in_a_fixed_order_and_nothing_from_the_proposal() =>
        Assert.Equal(WireBody, Webhook.Body(Row()));

    [Fact]
    public void The_signature_matches_the_test_vector_published_in_the_spec() =>
        Assert.Equal("sha256=8bd76bf7597eacb8a5c71c7b0485d267471f99bd208bc604aa570511a236f684", Webhook.Sign("s3cret", "1760580012", WireBody));

    [Fact]
    public void A_signed_delivery_has_a_timestamp_and_a_signature_and_an_unsigned_one_has_neither()
    {
        var signed = Webhook.Headers("s3cret", WireBody, DateTimeOffset.FromUnixTimeSeconds(1760580012));
        Assert.Equal("1760580012", signed["X-Hermes-Timestamp"]);
        Assert.Equal(Webhook.Sign("s3cret", "1760580012", WireBody), signed["X-Hermes-Signature"]);
        var unsigned = Webhook.Headers("", WireBody);
        Assert.False(unsigned.ContainsKey("X-Hermes-Timestamp") || unsigned.ContainsKey("X-Hermes-Signature"));
        Assert.Matches("^[0-9a-f]{32}$", unsigned["X-Hermes-Delivery"]);
        Assert.NotEqual(unsigned["X-Hermes-Delivery"], Webhook.Headers("", WireBody)["X-Hermes-Delivery"]);
    }

    [Theory]
    [InlineData("http://127.0.0.1:8795/hook", true)]
    [InlineData("https://agent.example/hooks/hermes?x=1", true)]
    [InlineData("ftp://example.com/x", false)]
    [InlineData("file:///etc/passwd", false)]
    [InlineData("http://user:pw@example.com/x", false)]
    [InlineData("not a url", false)]
    [InlineData("", false)]
    public void The_receiver_url_must_be_plain_http_or_https_without_credentials(string url, bool valid)
    {
        Assert.Equal(valid, Webhook.IsValidUrl(url));
        if (!valid) Assert.Throws<ArgumentException>(() => new WebhookNotifier(url));
    }

    // ---- the service -------------------------------------------------------------------------------------------------

    private sealed class Recorder : INotifier
    {
        public readonly List<ApprovalRow> Seen = new();
        public bool Throws { get; init; }
        public bool Signed { get; init; } = true;

        public Task DecidedAsync(ApprovalRow row)
        {
            lock (Seen) Seen.Add(row);
            if (Throws) throw new InvalidOperationException("the receiver is down");
            return Task.CompletedTask;
        }

        public int Count { get { lock (Seen) return Seen.Count; } }
    }

    private static ApprovalService Service(INotifier? notifier) =>
        new(new MemoryStore(), new MemoryCmsAdapter(), Profile.Seo(), notifier: notifier);

    private static JsonNode Submission() => JsonNode.Parse(
        """{"resourceType":"article","resourceId":42,"action":"update:canonical","scope":"seo:write","reason":"why","proposal":{"canonical":"https://example.com/c"}}""")!;

    private static readonly Reviewer Manager = new("manager");

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(20);
    }

    [Theory]
    [InlineData("approve", Status.Approved)]
    [InlineData("reject", Status.Rejected)]
    [InlineData("request-changes", Status.ChangesRequested)]
    public async Task A_stored_decision_is_announced_once_with_the_stored_row(string verb, string status)
    {
        var rec = new Recorder();
        var svc = Service(rec);
        var row = await svc.SubmitAsync(Submission());
        await Task.Delay(100);
        Assert.Equal(0, rec.Count);   // a submit announces nothing

        var decided = await svc.DecideAsync(row.ApprovalId, verb, Manager, JsonValue.Create("because"), false, null);
        await WaitUntil(() => rec.Count >= 1);
        await Task.Delay(100);
        Assert.Equal(1, rec.Count);
        Assert.Equal(status, rec.Seen[0].Status);
        Assert.Equal(decided.DecidedUtc, rec.Seen[0].DecidedUtc);
    }

    [Fact]
    public async Task Refused_decisions_repeated_decisions_and_writes_announce_nothing_more()
    {
        var rec = new Recorder();
        var svc = Service(rec);
        var row = await svc.SubmitAsync(Submission());

        await Assert.ThrowsAsync<ApprovalException>(() => svc.DecideAsync(row.ApprovalId, "reject", Manager, JsonValue.Create(""), false, null));
        await Assert.ThrowsAsync<ApprovalException>(() => svc.DecideAsync(row.ApprovalId, "request-changes", Manager, null, false, null));
        await Assert.ThrowsAsync<ApprovalException>(() => svc.DecideAsync(row.ApprovalId, "approve", null, JsonValue.Create(""), false, null));
        await Assert.ThrowsAsync<ApprovalException>(() => svc.DecideAsync(row.ApprovalId, "approve", Manager, JsonValue.Create(42), false, null));
        await Task.Delay(150);
        Assert.Equal(0, rec.Count);

        await svc.DecideAsync(row.ApprovalId, "approve", Manager, JsonValue.Create(""), false, null);
        await WaitUntil(() => rec.Count >= 1);
        await Assert.ThrowsAsync<ApprovalException>(() => svc.DecideAsync(row.ApprovalId, "approve", Manager, JsonValue.Create(""), false, null));
        await Assert.ThrowsAsync<ApprovalException>(() => svc.DecideAsync(row.ApprovalId, "reject", Manager, JsonValue.Create("late"), false, null));
        await svc.ExecuteAsync(JsonNode.Parse("{\"approvalId\":" + row.ApprovalId + ",\"resourceType\":\"article\",\"resourceId\":42,\"action\":\"update:canonical\",\"scope\":\"seo:write\",\"proposal\":{\"canonical\":\"https://example.com/c\"}}"));
        await Task.Delay(150);
        Assert.Equal(1, rec.Count);
    }

    [Fact]
    public async Task A_notifier_that_throws_never_undoes_or_fails_the_decision()
    {
        var rec = new Recorder { Throws = true };
        var svc = Service(rec);
        var row = await svc.SubmitAsync(Submission());
        var decided = await svc.DecideAsync(row.ApprovalId, "approve", Manager, JsonValue.Create(""), false, null);
        Assert.Equal(Status.Approved, decided.Status);
        Assert.Equal(Status.Approved, (await svc.GetAsync(row.ApprovalId)).Status);
        await WaitUntil(() => rec.Count >= 1);
        Assert.Equal(1, rec.Count);
    }

    [Fact]
    public void The_manifest_note_is_absent_without_a_notifier_and_says_whether_it_is_signed()
    {
        Assert.Null(Service(null).Notifications);
        Assert.Equal("""{"decision":true,"signed":true}""", Service(new Recorder { Signed = true }).Notifications!.ToJsonString());
        Assert.Equal("""{"decision":true,"signed":false}""", Service(new Recorder { Signed = false }).Notifications!.ToJsonString());
    }

    // ---- the sender --------------------------------------------------------------------------------------------------

    private sealed record Hit(string Method, string Path, string Body, Dictionary<string, string> Headers);

    /// <summary>A local receiver. `behave` decides the answer; it may also just never answer.</summary>
    private sealed class Receiver : IDisposable
    {
        private readonly HttpListener _listener = new();
        public readonly List<Hit> Hits = new();
        public string Url { get; }

        public Receiver(Func<HttpListenerContext, Task> behave)
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = $"http://127.0.0.1:{port}/hook";
            _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (_listener.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = await _listener.GetContextAsync(); } catch { return; }
                    _ = Task.Run(async () =>
                    {
                        string body;
                        using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = await reader.ReadToEndAsync();
                        var headers = ctx.Request.Headers.AllKeys.ToDictionary(k => k!.ToLowerInvariant(), k => ctx.Request.Headers[k]!);
                        lock (Hits) Hits.Add(new Hit(ctx.Request.HttpMethod, ctx.Request.Url!.AbsolutePath, body, headers));
                        try { await behave(ctx); } catch { /* the sender may have gone */ }
                    });
                }
            });
        }

        public static Task No(HttpListenerContext c, int status) { c.Response.StatusCode = status; c.Response.Close(); return Task.CompletedTask; }
        public int HitsTo(string path) { lock (Hits) return Hits.Count(h => h.Path == path); }
        public void Dispose() { try { _listener.Close(); } catch { /* already closed */ } }
    }

    [Fact]
    public async Task A_signed_delivery_arrives_as_documented()
    {
        using var rx = new Receiver(c => Receiver.No(c, 204));
        await new WebhookNotifier(rx.Url, "s3cret").DecidedAsync(Row());
        await WaitUntil(() => rx.HitsTo("/hook") >= 1);
        var hit = Assert.Single(rx.Hits);
        Assert.Equal("POST", hit.Method);
        Assert.StartsWith("application/json", hit.Headers["content-type"]);
        Assert.Equal(WireBody, hit.Body);
        Assert.Matches("^[0-9a-f]{32}$", hit.Headers["x-hermes-delivery"]);
        Assert.Equal(Webhook.Sign("s3cret", hit.Headers["x-hermes-timestamp"], hit.Body), hit.Headers["x-hermes-signature"]);
    }

    [Fact]
    public async Task Without_a_secret_the_delivery_is_unsigned()
    {
        using var rx = new Receiver(c => Receiver.No(c, 204));
        await new WebhookNotifier(rx.Url).DecidedAsync(Row());
        await WaitUntil(() => rx.HitsTo("/hook") >= 1);
        var hit = Assert.Single(rx.Hits);
        Assert.False(hit.Headers.ContainsKey("x-hermes-signature") || hit.Headers.ContainsKey("x-hermes-timestamp"));
    }

    [Fact]
    public async Task A_receiver_that_answers_500_or_is_down_never_throws_and_is_not_retried()
    {
        using var bad = new Receiver(c => Receiver.No(c, 500));
        await new WebhookNotifier(bad.Url, "s").DecidedAsync(Row());
        await Task.Delay(300);
        Assert.Equal(1, bad.HitsTo("/hook"));

        var gone = new Receiver(c => Receiver.No(c, 204));
        var url = gone.Url;
        gone.Dispose();
        await new WebhookNotifier(url, "s").DecidedAsync(Row());   // connection refused: returns, no exception
    }

    [Fact]
    public async Task A_receiver_that_never_answers_is_given_up_on_after_about_three_seconds()
    {
        using var slow = new Receiver(_ => Task.Delay(TimeSpan.FromSeconds(10)));
        var started = DateTime.UtcNow;
        await new WebhookNotifier(slow.Url, "s").DecidedAsync(Row());
        var took = DateTime.UtcNow - started;
        Assert.InRange(took.TotalSeconds, 2.5, 5);
    }

    [Fact]
    public async Task A_redirect_from_the_receiver_is_not_followed()
    {
        using var rx = new Receiver(c =>
        {
            if (c.Request.Url!.AbsolutePath == "/hook") { c.Response.StatusCode = 302; c.Response.RedirectLocation = "/elsewhere"; c.Response.Close(); return Task.CompletedTask; }
            return Receiver.No(c, 204);
        });
        await new WebhookNotifier(rx.Url, "s").DecidedAsync(Row());
        await Task.Delay(300);
        Assert.Equal(1, rx.HitsTo("/hook"));
        Assert.Equal(0, rx.HitsTo("/elsewhere"));
    }
}
