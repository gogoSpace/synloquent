<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Protocol;

use RuntimeException;

final class ProtocolException extends RuntimeException
{
    /** @param array<array-key, mixed> $details */
    public function __construct(public readonly string $errorCode, string $message, public readonly array $details = [], public readonly int $status = 422)
    {
        parent::__construct($message);
    }

    /** @return array<array-key, mixed> */
    public function payload(): array
    {
        return ['code' => $this->errorCode, 'message' => $this->getMessage(), 'details' => $this->details];
    }
}
