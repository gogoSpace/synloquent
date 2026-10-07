<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Query;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Query\Grammars\Grammar;
use Illuminate\Database\Query\Grammars\PostgresGrammar;

/** SQL expressions whose protocol semantics are more specific than Laravel's defaults. */
final class QueryExpressions
{
    public static function text(string $expression, Grammar $grammar): string
    {
        return $grammar instanceof PostgresGrammar ? $expression.' COLLATE "C"' : 'CONVERT('.$expression.' USING utf8mb4) COLLATE utf8mb4_nopad_bin';
    }

    public static function integer(Grammar $grammar): string
    {
        return $grammar instanceof PostgresGrammar ? 'CAST(? AS BIGINT)' : 'CAST(? AS SIGNED)';
    }

    public static function order(string $expression, string $direction, Grammar $grammar): string
    {
        return $expression.' '.$direction.($grammar instanceof PostgresGrammar ? ($direction === 'asc' ? ' NULLS FIRST' : ' NULLS LAST') : '');
    }

    /** @param Builder<Model> $query */
    public static function jsonContains(Builder $query, string $field, mixed $value): void
    {
        $grammar = $query->getQuery()->getGrammar();
        $column = $grammar->wrap($field);
        if ($grammar instanceof PostgresGrammar) {
            $query->whereRaw('jsonb_typeof('.$column.'::jsonb) = ?', ['array'])->whereJsonContains($field, [$value]);

            return;
        }
        $query->whereRaw('JSON_TYPE('.$column.') = ?', ['ARRAY']);
        $query->whereRaw('EXISTS (SELECT 1 FROM JSON_TABLE('.$column.", '$[*]' COLUMNS (value JSON PATH '$')) AS __synloquent_json WHERE JSON_EQUALS(__synloquent_json.value, ?) = 1)", [json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION)]);
    }

    /**
     * @param  Builder<Model>  $query
     * @param  list<string>  $segments
     */
    public static function jsonPath(Builder $query, string $field, array $segments, mixed $value): void
    {
        $grammar = $query->getQuery()->getGrammar();
        $column = $grammar->wrap($field);
        $path = [];
        $jsonPath = '$';
        foreach ($segments as $segment) {
            $object = str_starts_with($segment, '.');
            if ($grammar instanceof PostgresGrammar) {
                $query->whereRaw('jsonb_typeof('.$column.'::jsonb #> ?::text[]) = ?', ['{'.implode(',', $path).'}', $object ? 'object' : 'array']);
            } else {
                $query->whereRaw('JSON_TYPE(JSON_EXTRACT('.$column.', ?)) = ?', [$jsonPath, $object ? 'OBJECT' : 'ARRAY']);
            }
            $path[] = trim($segment, '.[]');
            $jsonPath .= $segment;
        }
        $encoded = json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
        if ($grammar instanceof PostgresGrammar) {
            $query->whereRaw('('.$column.'::jsonb #> ?::text[]) = ?::jsonb', ['{'.implode(',', $path).'}', $encoded]);
        } else {
            $query->whereRaw('JSON_EQUALS(JSON_EXTRACT('.$column.', ?), ?) = 1', [$jsonPath, $encoded]);
        }
    }
}
