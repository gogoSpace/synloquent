<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Contracts;

use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\WriteContext;

interface ServerCommand
{
    public function name(): string;

    /** @return array<string, array<string, mixed>> */
    public function arguments(): array;

    /** @return array<string, array<string, mixed>> */
    public function result(): array;

    /**
     * @param  array<string, mixed>  $result
     * @return array<string, mixed>|null
     */
    public function replay(array $result, ActorContext $actor): ?array;

    /** @return array<array-key, mixed> */
    public function argumentRules(): array;

    /** @return array<array-key, mixed> */
    public function resultRules(): array;

    public function authorize(ActorContext $actor): bool;

    /**
     * @param  array<array-key, mixed>  $arguments
     * @return array<array-key, mixed>
     */
    public function execute(array $arguments, WriteContext $context): array;
}
