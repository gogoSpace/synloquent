<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Protocol;

use stdClass;

final class WirePayload
{
    /**
     * @param  array<array-key, mixed>  $payload
     * @param  array<string, mixed>  $models
     * @return array<array-key, mixed>
     */
    public static function restore(string $kind, array $payload, stdClass $raw, array $models): array
    {
        if ($kind === 'command') {
            $payload['arguments'] = get_object_vars($raw->arguments);
        } elseif ($kind === 'query') {
            $payload = self::query($payload, $raw);
        } elseif ($kind === 'push') {
            foreach ($payload['operations'] as $position => &$operation) {
                $rawValues = $raw->operations[$position]->values;
                if ($operation['action'] === 'pivot' && isset($rawValues->attributes)) {
                    $fields = $models[$operation['model']]['relations'][$operation['values']['relation']]['pivot']['fields'] ?? [];
                    foreach ($fields as $field => $definition) {
                        if ($definition['type'] === 'json' && property_exists($rawValues->attributes, $field)) {
                            $operation['values']['attributes'][$field] = $rawValues->attributes->{$field};
                        }
                    }
                }
                foreach ($models[$operation['model']]['fields'] ?? [] as $field => $definition) {
                    if ($definition['type'] === 'json' && property_exists($rawValues, $field)) {
                        $operation['values'][$field] = $rawValues->{$field};
                    }
                }
            }
            unset($operation);
        }

        return $payload;
    }

    /**
     * @param  array<array-key, mixed>  $query
     * @return array<array-key, mixed>
     */
    private static function query(array $query, stdClass $raw): array
    {
        foreach ($query['scopes'] ?? [] as $position => $scope) {
            $query['scopes'][$position]['arguments'] = get_object_vars($raw->scopes[$position]->arguments);
        }
        foreach ($query['include'] ?? [] as $relation => $included) {
            $query['include'][$relation] = self::query($included, $raw->include->{$relation});
        }
        foreach (['subqueries', 'unions'] as $kind) {
            foreach ($query[$kind] ?? [] as $position => $branch) {
                $query[$kind][$position]['query'] = self::query($branch['query'], $raw->{$kind}[$position]->query);
            }
        }

        return $query;
    }
}
