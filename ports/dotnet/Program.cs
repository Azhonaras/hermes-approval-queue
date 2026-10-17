using HermesApproval.Cms;
using HermesApproval.Core;
using HermesApproval.Http;
using HermesApproval.Store;
using Microsoft.Data.SqlClient;

// Configuration comes from environment variables so the same build runs anywhere.
//   HERMES_DB            SQL Server connection string (required)
//   HERMES_READ_KEYS     comma-separated read keys
//   HERMES_WRITE_KEYS    comma-separated write keys
//   HERMES_REVIEW_SESSIONS  "session=reviewerId,..." (demo doors only)
//   HERMES_BASE_PATH     default /api/approvals
//   HERMES_CORS_ORIGIN   leave unset in production
//   HERMES_WEBHOOK_URL   optional: tell the agent's server when a person decides (docs/spec.md, "Decision notifications")
//   HERMES_WEBHOOK_SECRET  optional: sign those notifications; without it they are unsigned
//   HERMES_SEED=1        create the schema and demo content
static string[] List(string name) => (Environment.GetEnvironmentVariable(name) ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

var connectionString = Environment.GetEnvironmentVariable("HERMES_DB") ?? throw new InvalidOperationException("Set HERMES_DB");
var basePath = Environment.GetEnvironmentVariable("HERMES_BASE_PATH") ?? "/api/approvals";

if (Environment.GetEnvironmentVariable("HERMES_SEED") == "1") await Seed.RunAsync(connectionString);

var sessions = List("HERMES_REVIEW_SESSIONS").Select(p => p.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0], p => p[1]);
var doors = new StaticDoors(List("HERMES_READ_KEYS"), List("HERMES_WRITE_KEYS"), sessions);
INotifier? notifier = null;
if (Environment.GetEnvironmentVariable("HERMES_WEBHOOK_URL") is { Length: > 0 } webhookUrl)
{
    // The receiver is set here by the operator, never by the agent. A bad URL stops the start, so it cannot be silently off.
    notifier = new WebhookNotifier(webhookUrl, Environment.GetEnvironmentVariable("HERMES_WEBHOOK_SECRET") ?? "", LoggerFactory.Create(b => b.AddSimpleConsole()).CreateLogger("Hermes.Webhook"));
}
var service = new ApprovalService(new SqlServerStore(connectionString), new SqlCmsAdapter(connectionString), Profile.Seo(), notifier: notifier);

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(Environment.GetEnvironmentVariable("HERMES_URLS") ?? "http://127.0.0.1:8791");
var app = builder.Build();
app.MapApprovalApi(basePath, service, doors, Environment.GetEnvironmentVariable("HERMES_CORS_ORIGIN"));
app.Run();

/// <summary>Creates the tables and the same demo content the Node demo has, so one conformance profile fits both.</summary>
public static class Seed
{
    public static async Task RunAsync(string connectionString)
    {
        await using var conn = new SqlConnection(connectionString);
        await conn.OpenAsync();
        var schema = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "Schema.sql"));
        await using (var create = new SqlCommand(schema, conn)) await create.ExecuteNonQueryAsync();
        await using var seed = new SqlCommand(@"
            IF NOT EXISTS (SELECT 1 FROM dbo.CmsResources WHERE ResourceType = N'article' AND ResourceIdJson = N'42')
                INSERT INTO dbo.CmsResources VALUES (1, N'article', N'42', N'{""title"":""Sample guide"",""canonical"":""""}');
            IF NOT EXISTS (SELECT 1 FROM dbo.Approvals WHERE ApprovalId = 1036)
            BEGIN
                SET IDENTITY_INSERT dbo.Approvals ON;
                INSERT INTO dbo.Approvals (ApprovalId, SiteId, ResourceType, ResourceIdJson, Action, Scope, Status, Reason, ProposalJson, EditedProposal, CreatedUtc, DecidedUtc, DecidedBy, ExpiresUtc)
                VALUES (1036, 1, N'page', N'77', N'update:onpage', N'seo:write', N'Approved', N'Approval expired before the agent redeemed it.',
                        N'{""titleSeo"":""Expired sample""}', 0, '2020-01-01T09:00:00', '2020-01-01T09:10:00', N'manager.demo', '2020-01-02T09:00:00');
                SET IDENTITY_INSERT dbo.Approvals OFF;
            END", conn);
        await seed.ExecuteNonQueryAsync();
    }
}
