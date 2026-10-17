using System.Security.Cryptography;
using System.Text;
using HermesApproval.Core;

namespace HermesApproval.Http;

public sealed record AgentIdentity(bool Read, bool Write);

/// <summary>Who is calling. Plug in your own: the agent door is API keys, the reviewer door is your login session.</summary>
public interface IDoors
{
    AgentIdentity Agent(HttpContext context);
    Reviewer? Reviewer(HttpContext context);
}

/// <summary>
/// Demo doors: static API keys and a fixed header. For production, implement IDoors with
/// context.User (ASP.NET Core authentication) and check the manager role, e.g.
/// <c>context.User.IsInRole("Manager") ? new Reviewer(context.User.Identity!.Name!) : null</c>.
/// Never derive the reviewer from anything the agent can hold.
/// </summary>
public sealed class StaticDoors : IDoors
{
    private readonly string[] _readKeys, _writeKeys;
    private readonly Dictionary<string, string> _sessions;

    public StaticDoors(IEnumerable<string> readKeys, IEnumerable<string> writeKeys, Dictionary<string, string> sessions)
    {
        _readKeys = readKeys.ToArray(); _writeKeys = writeKeys.ToArray(); _sessions = sessions;
    }

    public AgentIdentity Agent(HttpContext c)
    {
        var key = c.Request.Headers["X-Api-Key"].ToString();
        var write = _writeKeys.Any(k => Same(k, key));
        return new AgentIdentity(write || _readKeys.Any(k => Same(k, key)), write);
    }

    public Reviewer? Reviewer(HttpContext c)
    {
        var session = c.Request.Headers["X-Review-Session"].ToString();
        foreach (var (value, id) in _sessions) if (Same(value, session)) return new Reviewer(id);
        return null;
    }

    private static bool Same(string a, string b) =>
        a.Length > 0 && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}
