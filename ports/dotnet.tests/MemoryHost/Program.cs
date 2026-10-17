using HermesApproval.Core;
using HermesApproval.Http;
using HermesApproval.Tests.Support;

// The .NET HTTP layer and service on an in-memory store, with the demo keys, so the conformance suite can run without
// SQL Server:   dotnet run --project ports/dotnet.tests/MemoryHost
//               node conformance/run.mjs --config conformance/profiles/dotnet-sqlserver.json
// It proves the routes, the rules and the notifier. It does not prove SQL transactions: that is StoreTests' job.
//   HERMES_URLS (default http://127.0.0.1:8791), HERMES_BASE_PATH (default /api/seo), HERMES_WEBHOOK_URL / HERMES_WEBHOOK_SECRET.
var store = new MemoryStore();
store.SeedExpiredFixture();
var doors = new StaticDoors(new[] { "demo-read" }, new[] { "demo-write" }, new Dictionary<string, string> { ["demo-manager"] = "manager.demo" });

INotifier? notifier = null;
if (Environment.GetEnvironmentVariable("HERMES_WEBHOOK_URL") is { Length: > 0 } url)
    notifier = new WebhookNotifier(url, Environment.GetEnvironmentVariable("HERMES_WEBHOOK_SECRET") ?? "", LoggerFactory.Create(b => b.AddSimpleConsole()).CreateLogger("Hermes.Webhook"));

var service = new ApprovalService(store, new MemoryCmsAdapter(), Profile.Seo(), notifier: notifier);
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(Environment.GetEnvironmentVariable("HERMES_URLS") ?? "http://127.0.0.1:8791");
var app = builder.Build();
app.MapApprovalApi(Environment.GetEnvironmentVariable("HERMES_BASE_PATH") ?? "/api/seo", service, doors, null);
app.Run();
