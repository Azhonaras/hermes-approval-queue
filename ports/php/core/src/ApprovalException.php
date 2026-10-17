<?php
declare(strict_types=1);

namespace Hermes\Approval;

/** A failure the API reports with a documented code (docs/spec.md). Anything else is a 500. */
final class ApprovalException extends \RuntimeException
{
    public const HTTP = [
        'BAD_REQUEST' => 400, 'DECISION_REASON_REQUIRED' => 400, 'UNAUTHORIZED' => 401, 'SCOPE_DENIED' => 403,
        'NOT_FOUND' => 404, 'APPROVAL_PENDING' => 409, 'APPROVAL_NOT_USABLE' => 409, 'APPROVAL_PAYLOAD_MISMATCH' => 409,
        'APPROVAL_MISMATCH' => 409, 'APPROVAL_EXPIRED' => 409, 'APPROVAL_NOT_PENDING' => 409,
        'REVISION_NOT_REQUESTED' => 409, 'REVISION_MISMATCH' => 409, 'PAYLOAD_TOO_LARGE' => 413, 'UNSUPPORTED_MEDIA_TYPE' => 415,
        'INTERNAL' => 500, 'WRITE_FAILED' => 502,
    ];

    public function __construct(public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }

    public function httpStatus(): int
    {
        return self::HTTP[$this->errorCode] ?? 500;
    }

    public static function of(string $code, string $message): self
    {
        return new self($code, $message);
    }
}
