/**
 * Error codes from docs/spec.md and the HTTP status each one maps to.
 */
export const ERROR_HTTP = Object.freeze({
  BAD_REQUEST: 400,
  DECISION_REASON_REQUIRED: 400,
  UNAUTHORIZED: 401,
  SCOPE_DENIED: 403,
  NOT_FOUND: 404,
  APPROVAL_PENDING: 409,
  APPROVAL_NOT_USABLE: 409,
  APPROVAL_PAYLOAD_MISMATCH: 409,
  APPROVAL_MISMATCH: 409,
  APPROVAL_EXPIRED: 409,
  APPROVAL_NOT_PENDING: 409,
  REVISION_NOT_REQUESTED: 409,
  REVISION_MISMATCH: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL: 500,
  WRITE_FAILED: 502
});

export class ApprovalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.http = ERROR_HTTP[code] || 500;
  }
}

export function fail(code, message) {
  throw new ApprovalError(code, message);
}
