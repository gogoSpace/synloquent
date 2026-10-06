<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Export;

use BackedEnum;
use Carbon\CarbonImmutable;
use DateTimeInterface;
use Illuminate\Contracts\Support\Arrayable;
use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Protocol\ProtocolException;

final class ValueCodec
{
    /** @param array<array-key, mixed>|null $declaration */
    public function modelAttribute(Model $model, string $field, ?array $declaration = null): mixed
    {
        $cast = $model->getCasts()[$field] ?? null;
        $value = $model->getAttribute($field);
        if (in_array($cast, ['array', 'json', 'object'], true) && ! $model->hasGetMutator($field) && ! $model->hasAttributeGetMutator($field) && is_string($model->getAttributes()[$field] ?? null)) {
            $value = json_decode($model->getAttributes()[$field], flags: JSON_THROW_ON_ERROR);
        }

        return $this->encode($value, $declaration, $cast);
    }

    /**
     * @param  array<array-key, mixed>  $values
     * @return array<array-key, mixed>
     */
    public function validationData(array $values): array
    {
        return array_map(fn (mixed $value): mixed => $this->validationValue($value), $values);
    }

    private function validationValue(mixed $value): mixed
    {
        if ($value instanceof \stdClass) {
            $value = get_object_vars($value);
        }

        return is_array($value) ? $this->validationData($value) : $value;
    }

    /**
     * @param  array<array-key, mixed>  $validated
     * @param  array<array-key, mixed>  $original
     * @param  array<string, array<string, mixed>>  $definitions
     * @return array<array-key, mixed>
     */
    public function validatedValues(array $validated, array $original, array $definitions): array
    {
        foreach ($validated as $field => &$value) {
            if (($definitions[$field]['type'] ?? null) === 'json') {
                $value = $this->restoreJsonTypes($value, $original[$field]);
            }
        }
        unset($value);

        return $validated;
    }

    private function restoreJsonTypes(mixed $validated, mixed $original): mixed
    {
        if (! is_array($validated)) {
            return $validated;
        }
        $properties = $original instanceof \stdClass ? get_object_vars($original) : $original;
        foreach ($validated as $field => &$value) {
            $value = $this->restoreJsonTypes($value, $properties[$field]);
        }
        unset($value);

        return $original instanceof \stdClass ? (object) $validated : $validated;
    }

    /** @param array<array-key, mixed>|null $declaration */
    public function encode(mixed $value, ?array $declaration = null, ?string $cast = null): mixed
    {
        if ($value === null) {
            return null;
        }
        $type = $declaration['type'] ?? explode(':', $cast ?? '')[0];
        if ($value instanceof BackedEnum) {
            return $value->value;
        }
        if ($value instanceof DateTimeInterface) {
            if (in_array($type, ['date', 'immutable_date'], true)) {
                return $value->format('Y-m-d');
            }

            return $value->getOffset() === 0 ? $value->format('Y-m-d\TH:i:s.u\Z') : CarbonImmutable::instance($value)->utc()->format('Y-m-d\TH:i:s.u\Z');
        }
        if (in_array($type, ['decimal', 'bigint', 'identity'], true)) {
            return (string) $value;
        }
        if (in_array($type, ['bool', 'boolean'], true)) {
            return (bool) $value;
        }
        if (is_int($value) && abs($value) > 9007199254740991) {
            return (string) $value;
        }
        if ($value instanceof Arrayable) {
            return $value->toArray();
        }

        return $value;
    }

    private function validDate(string $value): bool
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value);

        return $date !== false && $date->format('Y-m-d') === $value;
    }

    /** @param array<array-key, mixed> $field */
    public function validate(mixed $value, array $field, string $name): void
    {
        if ($value === null && ($field['nullable'] ?? false)) {
            return;
        }
        $valid = match ($field['type']) {
            'integer' => (is_int($value) && abs($value) <= 9007199254740991) || (is_string($value) && $value !== '-0' && preg_match('/^-?(?:0|[1-9][0-9]*)$/D', $value)),
            'identity', 'bigint' => is_string($value) && preg_match('/^-?[0-9]+$/D', $value),
            'string' => is_string($value),
            'boolean' => is_bool($value),
            'float' => is_int($value) || (is_float($value) && is_finite($value)),
            'decimal' => is_string($value) && preg_match('/^-?[0-9]+(?:\.[0-9]+)?$/D', $value),
            'date' => is_string($value) && preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/D', $value) && $this->validDate($value),
            'datetime' => is_string($value) && preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/D', $value),
            'json' => (is_array($value) || $value instanceof \stdClass || is_scalar($value)) && self::finite($value),
            'enum' => in_array($value, $field['enum'] ?? [], true),
            default => false,
        };
        if (! $valid) {
            throw new ProtocolException('validation_failed', 'Invalid canonical value for '.$name, ['field' => $name]);
        }
    }

    public static function finite(mixed $value): bool
    {
        if (is_float($value)) {
            return is_finite($value);
        }
        if (is_array($value) || $value instanceof \stdClass) {
            foreach ($value as $item) {
                if (! self::finite($item)) {
                    return false;
                }
            }
        }

        return true;
    }
}
