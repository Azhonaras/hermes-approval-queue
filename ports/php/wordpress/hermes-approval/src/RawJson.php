<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

/** A response body that is already JSON text, so WordPress does not re-encode it (wp_json_encode would change numbers and escape Unicode). */
final class RawJson
{
    public function __construct(public readonly string $json)
    {
    }
}
