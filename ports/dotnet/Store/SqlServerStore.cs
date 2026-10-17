using System.Text.Json.Nodes;
using HermesApproval.Core;
using Microsoft.Data.SqlClient;

namespace HermesApproval.Store;

/// <summary>
/// SQL Server store. The safety rule lives in one place: every state change is a conditional UPDATE
/// (WHERE Status = @from) and the caller checks that a row came back. Two writers cannot both win.
/// </summary>
public sealed class SqlServerStore : IApprovalStore
{
    private const string Columns =
        "ApprovalId, SiteId, ResourceType, ResourceIdJson, Action, Scope, Status, Reason, ProposalJson, OriginalProposalJson, " +
        "EditedProposal, DecisionReason, RevisionOfApprovalId, CreatedUtc, DecidedUtc, DecidedBy, ExpiresUtc";
    private const string InsertedColumns =
        "INSERTED.ApprovalId, INSERTED.SiteId, INSERTED.ResourceType, INSERTED.ResourceIdJson, INSERTED.Action, INSERTED.Scope, INSERTED.Status, " +
        "INSERTED.Reason, INSERTED.ProposalJson, INSERTED.OriginalProposalJson, INSERTED.EditedProposal, INSERTED.DecisionReason, " +
        "INSERTED.RevisionOfApprovalId, INSERTED.CreatedUtc, INSERTED.DecidedUtc, INSERTED.DecidedBy, INSERTED.ExpiresUtc";

    private readonly string _connectionString;

    public SqlServerStore(string connectionString) => _connectionString = connectionString;

    public async Task<ApprovalRow> InsertAsync(NewApproval v)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new SqlCommand($@"
            INSERT INTO dbo.Approvals (SiteId, ResourceType, ResourceIdJson, Action, Scope, Status, Reason, ProposalJson, EditedProposal,
                                       RevisionOfApprovalId, CreatedUtc, ExpiresUtc)
            OUTPUT {InsertedColumns}
            VALUES (@site, @type, @rid, @action, @scope, N'Pending', @reason, @proposal, 0, @rev, @created, @expires)", conn);
        cmd.Parameters.AddWithValue("@site", v.SiteId);
        cmd.Parameters.AddWithValue("@type", v.ResourceType);
        cmd.Parameters.AddWithValue("@rid", StrictJson.ToText(v.ResourceId));
        cmd.Parameters.AddWithValue("@action", v.Action);
        cmd.Parameters.AddWithValue("@scope", v.Scope);
        cmd.Parameters.AddWithValue("@reason", v.Reason);
        cmd.Parameters.AddWithValue("@proposal", StrictJson.ToText(v.Proposal));
        cmd.Parameters.AddWithValue("@rev", (object?)v.RevisionOfApprovalId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@created", v.CreatedUtc);
        cmd.Parameters.AddWithValue("@expires", v.ExpiresUtc);
        await using var reader = await cmd.ExecuteReaderAsync();
        await reader.ReadAsync();
        return Map(reader);
    }

    public async Task<ApprovalRow?> GetAsync(long id)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new SqlCommand($"SELECT {Columns} FROM dbo.Approvals WHERE ApprovalId = @id", conn);
        cmd.Parameters.AddWithValue("@id", id);
        await using var reader = await cmd.ExecuteReaderAsync();
        return await reader.ReadAsync() ? Map(reader) : null;
    }

    public async Task<IReadOnlyList<ApprovalRow>> ListAsync(IReadOnlyCollection<string> statuses)
    {
        await using var conn = await OpenAsync();
        var names = statuses.Select((_, i) => "@s" + i).ToArray();
        await using var cmd = new SqlCommand($"SELECT {Columns} FROM dbo.Approvals WHERE Status IN ({string.Join(",", names)})", conn);
        var n = 0;
        foreach (var s in statuses) cmd.Parameters.AddWithValue("@s" + n++, s);
        var rows = new List<ApprovalRow>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync()) rows.Add(Map(reader));
        return rows;
    }

    public async Task<ApprovalRow?> TransitionAsync(long id, string from, Patch p)
    {
        await using var conn = await OpenAsync();
        return await TransitionAsync(conn, null, id, from, p);
    }

    private static async Task<ApprovalRow?> TransitionAsync(SqlConnection conn, SqlTransaction? tx, long id, string from, Patch p)
    {
        var sets = new List<string> { "Status = @status" };
        await using var cmd = new SqlCommand { Connection = conn, Transaction = tx };
        cmd.Parameters.AddWithValue("@status", p.Status);
        void Set(string column, string name, object? value)
        {
            sets.Add($"{column} = {name}");
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }
        if (p.DecisionReason is not null) Set("DecisionReason", "@reason", p.DecisionReason);
        if (p.DecidedUtc is not null) Set("DecidedUtc", "@decided", p.DecidedUtc);
        if (p.DecidedBy is not null) Set("DecidedBy", "@by", p.DecidedBy);
        if (p.Proposal is not null) Set("ProposalJson", "@proposal", StrictJson.ToText(p.Proposal));
        if (p.OriginalProposal is not null) Set("OriginalProposalJson", "@original", StrictJson.ToText(p.OriginalProposal));
        if (p.EditedProposal is not null) Set("EditedProposal", "@edited", p.EditedProposal.Value);
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@from", from);
        cmd.CommandText = $"UPDATE dbo.Approvals SET {string.Join(", ", sets)} OUTPUT {InsertedColumns} WHERE ApprovalId = @id AND Status = @from";
        await using var reader = await cmd.ExecuteReaderAsync();
        return await reader.ReadAsync() ? Map(reader) : null;
    }

    public async Task<ConsumeResult> ConsumeAsync(long id, DateTime nowUtc, Func<ApprovalRow, object?, Task<JsonNode?>> apply)
    {
        await using var conn = await OpenAsync();
        await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();
        try
        {
            // The claim: only one concurrent transaction can move Approved -> Consumed; the others block on the row lock,
            // then find Status <> Approved and get zero rows.
            var claimed = await TransitionAsync(conn, tx, id, Status.Approved, new Patch(Status.Consumed));
            if (claimed is null) { await tx.RollbackAsync(); return new ConsumeResult(null, null); }

            var result = await apply(claimed, tx);

            await using (var mark = new SqlCommand("UPDATE dbo.Approvals SET ConsumedUtc = @now WHERE ApprovalId = @id", conn, tx))
            {
                mark.Parameters.AddWithValue("@now", nowUtc);
                mark.Parameters.AddWithValue("@id", id);
                await mark.ExecuteNonQueryAsync();
            }
            await using (var audit = new SqlCommand(@"INSERT INTO dbo.AuditLog (ApprovalId, Action, ResourceType, ResourceIdJson, ProposalJson)
                                                      VALUES (@id, @action, @type, @rid, @proposal)", conn, tx))
            {
                audit.Parameters.AddWithValue("@id", id);
                audit.Parameters.AddWithValue("@action", claimed.Action);
                audit.Parameters.AddWithValue("@type", claimed.ResourceType);
                audit.Parameters.AddWithValue("@rid", StrictJson.ToText(claimed.ResourceId));
                audit.Parameters.AddWithValue("@proposal", StrictJson.ToText(claimed.Proposal));
                await audit.ExecuteNonQueryAsync();
            }
            await tx.CommitAsync();
            return new ConsumeResult(claimed, result);
        }
        catch
        {
            await tx.RollbackAsync();   // the claim is undone too: the row is Approved again and can be retried
            throw;
        }
    }

    private async Task<SqlConnection> OpenAsync()
    {
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        return conn;
    }

    private static ApprovalRow Map(SqlDataReader r) => new()
    {
        ApprovalId = r.GetInt64(0),
        SiteId = r.GetInt32(1),
        ResourceType = r.GetString(2),
        ResourceId = JsonNode.Parse(r.GetString(3))!,
        Action = r.GetString(4),
        Scope = r.GetString(5),
        Status = r.GetString(6),
        Reason = r.GetString(7),
        Proposal = (JsonObject)JsonNode.Parse(r.GetString(8))!,
        OriginalProposal = r.IsDBNull(9) ? null : (JsonObject)JsonNode.Parse(r.GetString(9))!,
        EditedProposal = r.GetBoolean(10),
        DecisionReason = r.IsDBNull(11) ? null : r.GetString(11),
        RevisionOfApprovalId = r.IsDBNull(12) ? null : r.GetInt64(12),
        CreatedUtc = DateTime.SpecifyKind(r.GetDateTime(13), DateTimeKind.Utc),
        DecidedUtc = r.IsDBNull(14) ? null : DateTime.SpecifyKind(r.GetDateTime(14), DateTimeKind.Utc),
        DecidedBy = r.IsDBNull(15) ? null : r.GetString(15),
        ExpiresUtc = DateTime.SpecifyKind(r.GetDateTime(16), DateTimeKind.Utc)
    };
}
