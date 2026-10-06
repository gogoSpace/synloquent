<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Protocol;

final class CanonicalJson
{
    public static function encode(mixed $value): string
    {
        return json_encode(self::normalize($value), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    }

    public static function hash(mixed $value): string
    {
        return hash('sha256', self::encode($value));
    }

    /**
     * @param  list<array<array-key, mixed>>  $records
     * @param  list<array<array-key, mixed>>  $relationSets
     */
    public static function catalog(array $records, array $relationSets): string
    {
        return '{"records":'.self::list($records).',"relationSets":'.self::list($relationSets).'}';
    }

    /** @param list<array<array-key, mixed>> $values */
    private static function list(array $values): string
    {
        $chunks = [];
        foreach (array_chunk($values, 1000) as $chunk) {
            $chunks[] = substr(self::encode($chunk), 1, -1);
        }

        return '['.implode(',', $chunks).']';
    }

    private static function normalize(mixed $value, bool $wireValue = false): mixed
    {
        if (is_object($value)) {
            return (object) self::normalize(get_object_vars($value), $wireValue);
        }
        if (! is_array($value)) {
            return $value;
        }
        if (! array_is_list($value)) {
            ksort($value, SORT_STRING);
        }
        foreach ($value as $key => &$item) {
            $item = self::normalize($item, $wireValue || in_array($key, ['attributes', 'arguments', 'result', 'default', 'value'], true));
            if (! $wireValue && in_array($key, ['models', 'fields', 'relations', 'morphMap', 'attributes', 'arguments', 'result', 'commands', 'scopes', 'details'], true) && is_array($item)) {
                $item = (object) $item;
            }
        }

        return $value;
    }
}
