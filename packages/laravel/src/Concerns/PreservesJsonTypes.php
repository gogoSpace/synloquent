<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Concerns;

use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Protocol\CanonicalJson;

/** @phpstan-require-extends Model */
trait PreservesJsonTypes
{
    public function originalIsEquivalent($key): bool
    {
        $current = $this->getAttributes()[$key] ?? null;
        $original = $this->getRawOriginal($key);
        if (in_array($this->getCasts()[$key] ?? null, ['array', 'json', 'object'], true) && ! $this->hasGetMutator($key) && ! $this->hasAttributeGetMutator($key) && is_string($current) && is_string($original)) {
            return CanonicalJson::encode(json_decode($current, flags: JSON_THROW_ON_ERROR)) === CanonicalJson::encode(json_decode($original, flags: JSON_THROW_ON_ERROR));
        }

        return parent::originalIsEquivalent($key);
    }
}
