namespace HermesApproval.Core;

/// <summary>An error with a documented code (docs/spec.md) and the HTTP status it maps to.</summary>
public sealed class ApprovalException : Exception
{
    private static readonly Dictionary<string, int> Http = new()
    {
        ["BAD_REQUEST"] = 400, ["DECISION_REASON_REQUIRED"] = 400, ["UNAUTHORIZED"] = 401, ["SCOPE_DENIED"] = 403,
        ["NOT_FOUND"] = 404, ["APPROVAL_PENDING"] = 409, ["APPROVAL_NOT_USABLE"] = 409, ["APPROVAL_PAYLOAD_MISMATCH"] = 409,
        ["APPROVAL_MISMATCH"] = 409, ["APPROVAL_EXPIRED"] = 409, ["APPROVAL_NOT_PENDING"] = 409,
        ["REVISION_NOT_REQUESTED"] = 409, ["REVISION_MISMATCH"] = 409, ["PAYLOAD_TOO_LARGE"] = 413, ["UNSUPPORTED_MEDIA_TYPE"] = 415,
        ["INTERNAL"] = 500, ["WRITE_FAILED"] = 502
    };

    public string Code { get; }
    public int HttpStatus => Http.GetValueOrDefault(Code, 500);

    public ApprovalException(string code, string message) : base(message) => Code = code;

    public static ApprovalException Fail(string code, string message) => new(code, message);
}
