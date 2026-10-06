<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Export;

use Synloquent\Laravel\Contracts\ResourceExport;
use Synloquent\Laravel\Protocol\ProtocolException;

final class ExportRegistry
{
    /** @var array<string, ResourceExport> */
    /** @var array<array-key, mixed> */
    private array $resources = [];

    public function register(ResourceExport $resource): void
    {
        if (! preg_match('/^[A-Za-z][A-Za-z0-9_]*$/D', $resource->name()) || isset($this->resources[$resource->name()])) {
            throw new ProtocolException('schema_mismatch', 'Resource names must be stable unique identifiers.');
        }
        $this->resources[$resource->name()] = $resource;
    }

    public function get(string $name): ResourceExport
    {
        return $this->resources[$name] ?? throw new ProtocolException('unknown_model', 'Unknown exported resource '.$name);
    }

    /** @return array<string, ResourceExport> */
    public function all(): array
    {
        $resources = $this->resources;
        ksort($resources);

        return $resources;
    }

    public function nameForClass(string $class): string
    {
        foreach ($this->resources as $resource) {
            if ($resource->modelClass() === $class) {
                return $resource->name();
            }
        }
        throw new ProtocolException('unknown_model', 'Related model is not explicitly exported: '.$class);
    }
}
