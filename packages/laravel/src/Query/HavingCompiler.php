<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Query;

use Illuminate\Database\Query\Grammars\Grammar;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\ProtocolException;

final class HavingCompiler
{
    private int $nodes = 0;

    public function __construct(private ValueCodec $values) {}

    /**
     * @param  array<array-key, mixed>  $predicate
     * @param  array<string, array<array-key, mixed>>  $fields
     * @return array{string, list<mixed>}
     */
    public function compile(array $predicate, array $fields, string $expression, Grammar $grammar): array
    {
        $this->nodes = 0;

        return $this->predicate($predicate, $fields, $expression, $grammar, 0);
    }

    /**
     * @param  array<array-key, mixed>  $predicate
     * @param  array<string, array<array-key, mixed>>  $fields
     * @return array{string, list<mixed>}
     */
    private function predicate(array $predicate, array $fields, string $expression, Grammar $grammar, int $depth): array
    {
        if (++$this->nodes > config('synloquent.max_query_nodes', 100) || $depth > config('synloquent.max_query_depth', 8)) {
            throw new ProtocolException('unsupported_query', 'HAVING complexity exceeded.');
        }
        if (($predicate['kind'] ?? '') === 'group') {
            $predicates = $predicate['predicates'] ?? [];
            if (! is_array($predicates) || ! array_is_list($predicates) || $predicates === [] || ! in_array($predicate['boolean'] ?? '', ['and', 'or'], true)) {
                throw new ProtocolException('unsupported_query', 'Invalid HAVING group.');
            }
            $fragments = [];
            $bindings = [];
            foreach ($predicates as $child) {
                [$sql, $values] = $this->predicate($child, $fields, $expression, $grammar, $depth + 1);
                $fragments[] = $sql;
                array_push($bindings, ...$values);
            }

            return ['('.implode(' '.strtoupper($predicate['boolean']).' ', $fragments).')', $bindings];
        }
        if (($predicate['kind'] ?? '') === 'not') {
            [$sql, $bindings] = $this->predicate($predicate['predicate'] ?? [], $fields, $expression, $grammar, $depth + 1);

            return ['NOT ('.$sql.')', $bindings];
        }
        $field = $predicate['field'] ?? '';
        $column = $this->field($field, $fields, $expression, $grammar);
        $operator = $predicate['operator'] ?? '';
        $operators = ['=' => '=', '!=' => '!=', '<' => '<', '<=' => '<=', '>' => '>', '>=' => '>=', 'like' => 'LIKE'];
        if (($predicate['kind'] ?? '') === 'column') {
            if (! isset($operators[$operator]) || $operator === 'like') {
                throw new ProtocolException('unsupported_query', 'Invalid HAVING column operator.');
            }

            return [$column.' '.$operators[$operator].' '.$this->field($predicate['otherField'] ?? '', $fields, $expression, $grammar), []];
        }
        if (($predicate['kind'] ?? '') !== 'comparison') {
            throw new ProtocolException('unsupported_query', 'HAVING supports grouped scalar predicates only.');
        }
        if (in_array($operator, ['isNull', 'isNotNull'], true)) {
            return [$column.($operator === 'isNull' ? ' IS NULL' : ' IS NOT NULL'), []];
        }
        $value = $predicate['value'] ?? null;
        if (in_array($operator, ['in', 'notIn', 'between', 'notBetween'], true)) {
            if (! is_array($value) || ! array_is_list($value) || count($value) > 1000 || (in_array($operator, ['between', 'notBetween'], true) && count($value) !== 2)) {
                throw new ProtocolException('unsupported_query', 'HAVING values exceed declared bounds.');
            }
            foreach ($value as $item) {
                $this->value($field, $item, $fields);
            }
            if ($value === []) {
                return [$operator === 'in' ? 'FALSE' : 'TRUE', []];
            }
            if (in_array($operator, ['between', 'notBetween'], true)) {
                return [$column.($operator === 'between' ? ' BETWEEN ? AND ?' : ' NOT BETWEEN ? AND ?'), $value];
            }

            return [$column.($operator === 'in' ? ' IN (' : ' NOT IN (').implode(', ', array_fill(0, count($value), '?')).')', $value];
        }
        if (! isset($operators[$operator])) {
            throw new ProtocolException('unsupported_query', 'Unknown HAVING operator.');
        }
        $this->value($field, $value, $fields);

        return [$column.' '.$operators[$operator].' ?', [$value]];
    }

    /** @param array<string, array<array-key, mixed>> $fields */
    private function field(string $field, array $fields, string $expression, Grammar $grammar): string
    {
        if ($field === '$aggregate') {
            return $expression;
        }
        if (! isset($fields[$field])) {
            throw new ProtocolException('unknown_field', 'HAVING field must be a declared grouped field.');
        }

        $column = $grammar->wrap($fields[$field]['column'] ?? $field);

        return $fields[$field]['type'] === 'string' ? QueryExpressions::text($column, $grammar) : $column;
    }

    /** @param array<string, array<array-key, mixed>> $fields */
    private function value(string $field, mixed $value, array $fields): void
    {
        if ($field === '$aggregate') {
            if (! (is_int($value) || (is_float($value) && is_finite($value)) || (is_string($value) && preg_match('/^-?[0-9]+(?:\.[0-9]+)?$/D', $value)))) {
                throw new ProtocolException('unsupported_query', 'Aggregate comparison requires an exact numeric value.');
            }
        } else {
            $this->values->validate($value, $fields[$field], $field);
        }
    }
}
