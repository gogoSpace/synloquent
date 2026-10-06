<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Protocol;

use Closure;
use RuntimeException;
use stdClass;

/** Compiles the small catalog schema vocabulary. Other schemas retain the general validator. */
final class CatalogSchemaCompiler
{
    /** @var array<string, Closure(mixed): bool> */
    private array $documents = [];

    /** @var array<string, Closure(mixed): bool> */
    private array $sections = [];

    public function __construct()
    {
        foreach (['value', 'record', 'relation-set'] as $name) {
            $schema = json_decode(file_get_contents(__DIR__.'/Schemas/'.$name.'.schema.json'), flags: JSON_THROW_ON_ERROR);
            $this->documents[$name] = $this->compile($schema, $name);
        }
        $snapshot = json_decode(file_get_contents(__DIR__.'/Schemas/snapshot.schema.json'), flags: JSON_THROW_ON_ERROR);
        foreach (['records', 'relationSets'] as $section) {
            $this->sections[$section] = $this->compile($snapshot->properties->{$section}, 'snapshot');
        }
    }

    public function valid(string $section, mixed $value): bool
    {
        return isset($this->sections[$section]) && ($this->sections[$section])($value);
    }

    /** @return Closure(mixed): bool */
    private function compile(stdClass $schema, string $document): Closure
    {
        $keywords = get_object_vars($schema);
        $supported = ['$schema', '$id', '$ref', 'type', 'anyOf', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'maxItems', 'maxProperties', 'minLength', 'maxLength'];
        if (array_diff(array_keys($keywords), $supported) !== []) {
            throw new RuntimeException('Catalog schema requires the general validator.');
        }
        if (isset($schema->{'$ref'})) {
            if (array_diff(array_keys($keywords), ['$schema', '$id', '$ref']) !== []) {
                throw new RuntimeException('Catalog reference siblings require the general validator.');
            }
            $reference = $schema->{'$ref'};
            $name = $reference === '#' ? $document : preg_replace('/\.schema\.json$/D', '', $reference);
            if (! in_array($name, ['value', 'record', 'relation-set'], true)) {
                throw new RuntimeException('Unknown catalog reference.');
            }

            return fn (mixed $value): bool => isset($this->documents[$name]) && ($this->documents[$name])($value);
        }
        if (isset($schema->anyOf)) {
            if (array_diff(array_keys($keywords), ['$schema', '$id', 'anyOf']) !== []) {
                throw new RuntimeException('Catalog union siblings require the general validator.');
            }
            $branches = [];
            foreach ($schema->anyOf as $branch) {
                if (! isset($branch->type) || ! is_string($branch->type) || isset($branches[$branch->type])) {
                    throw new RuntimeException('Ambiguous catalog union.');
                }
                $branches[$branch->type] = $this->compile($branch, $document);
            }

            return function (mixed $value) use ($branches): bool {
                $type = match (true) {
                    $value === null => 'null', is_bool($value) => 'boolean', is_int($value), is_float($value) => 'number', is_string($value) => 'string', is_array($value) => 'array', $value instanceof stdClass => 'object', default => '',
                };

                return isset($branches[$type]) && $branches[$type]($value);
            };
        }
        $type = $schema->type ?? null;
        $enum = $schema->enum ?? null;
        if ($enum !== null && array_filter($enum, static fn (mixed $value): bool => ! is_string($value)) !== []) {
            throw new RuntimeException('Non-string catalog enum requires the general validator.');
        }
        $properties = [];
        foreach (get_object_vars($schema->properties ?? new stdClass) as $name => $property) {
            $properties[$name] = $this->compile($property, $document);
        }
        $required = $schema->required ?? [];
        $additional = $schema->additionalProperties ?? true;
        if ($additional instanceof stdClass) {
            $additional = $this->compile($additional, $document);
        }
        $items = isset($schema->items) ? $this->compile($schema->items, $document) : null;
        $maximumItems = $schema->maxItems ?? PHP_INT_MAX;
        $maximumProperties = $schema->maxProperties ?? PHP_INT_MAX;
        $minimumLength = $schema->minLength ?? 0;
        $maximumLength = $schema->maxLength ?? PHP_INT_MAX;
        if (! in_array($type, [null, 'null', 'boolean', 'number', 'integer', 'string', 'array', 'object'], true)) {
            throw new RuntimeException('Unknown catalog type.');
        }

        return static function (mixed $value) use ($type, $enum, $properties, $required, $additional, $items, $maximumItems, $maximumProperties, $minimumLength, $maximumLength): bool {
            $matches = match ($type) {
                null => true, 'null' => $value === null, 'boolean' => is_bool($value), 'number' => is_int($value) || (is_float($value) && is_finite($value)), 'integer' => is_int($value) || (is_float($value) && is_finite($value) && floor($value) === $value), 'string' => is_string($value), 'array' => is_array($value) && array_is_list($value), 'object' => $value instanceof stdClass,
            };
            if (! $matches || ($enum !== null && ! in_array($value, $enum, true))) {
                return false;
            }
            if (is_string($value)) {
                $length = mb_strlen($value, 'UTF-8');
                if ($length < $minimumLength || $length > $maximumLength) {
                    return false;
                }
            }
            if (is_array($value)) {
                if (count($value) > $maximumItems) {
                    return false;
                }
                if ($items !== null) {
                    foreach ($value as $item) {
                        if (! $items($item)) {
                            return false;
                        }
                    }
                }
            }
            if ($value instanceof stdClass) {
                $members = get_object_vars($value);
                if (count($members) > $maximumProperties || array_diff($required, array_keys($members)) !== []) {
                    return false;
                }
                foreach ($members as $name => $member) {
                    if (isset($properties[$name])) {
                        if (! $properties[$name]($member)) {
                            return false;
                        }
                    } elseif ($additional === false || ($additional instanceof Closure && ! $additional($member))) {
                        return false;
                    }
                }
            }

            return true;
        };
    }
}
