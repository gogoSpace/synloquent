<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Synloquent\Laravel\Contracts\ServerCommand;
use Synloquent\Laravel\Protocol\ProtocolException;

final class CommandRegistry
{
    /** @var array<array-key, mixed> */
    private array $commands = [];

    public function register(ServerCommand $command): void
    {
        $this->commands[$command->name()] = $command;
    }

    /** @return array<string, ServerCommand> */
    public function all(): array
    {
        $commands = $this->commands;
        ksort($commands);

        return $commands;
    }

    public function get(string $name): ServerCommand
    {
        return $this->commands[$name] ?? throw new ProtocolException('forbidden_operation', 'Server command is not registered.');
    }
}
