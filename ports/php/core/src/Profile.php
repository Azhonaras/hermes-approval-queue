<?php
declare(strict_types=1);

namespace Hermes\Approval;

/** The CMS-specific vocabulary: which actions and scopes exist and how large a proposal may be. */
final class Profile
{
    public const MAX_RESOURCE_TYPE_CHARS = 100;
    public const MAX_RESOURCE_ID_CHARS = 200;

    /** @param list<string> $actions @param list<string> $scopes */
    public function __construct(
        public readonly array $actions,
        public readonly array $scopes,
        public readonly int $maxFields = 40,
        public readonly int $maxJsonChars = 16384,
        public readonly int $maxReasonChars = 1024,
    ) {
        foreach ($actions as $a) {
            if (!preg_match('/^[a-z]+:[a-z0-9._-]+$/iD', $a)) {
                throw new \InvalidArgumentException("actions must look like verb:target, got $a");
            }
        }
    }

    public static function seo(): self
    {
        return new self(
            ['update:onpage', 'update:canonical', 'update:redirect', 'update:schema', 'update:indexing', 'update:contentlinks',
             'create:taxonomy', 'update:taxonomy', 'delete:taxonomy', 'merge:taxonomy'],
            ['seo:write', 'content:update', 'schema:manage'],
        );
    }

    public static function isDelete(string $action): bool
    {
        return str_starts_with($action, 'delete:');
    }
}
