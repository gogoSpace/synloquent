<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Closure;

final class StageProfiler
{
    private ?Closure $observer = null;

    /** @var array<string, array<string, float|int>> */
    private array $collected = [];

    public function collect(): void
    {
        $this->collected = [];
        $this->observe(function (string $stage, array $measurement): void {
            $phase = $this->collected[$stage] ?? ['seconds' => 0.0, 'calls' => 0, 'items' => 0];
            $this->collected[$stage] = ['seconds' => $phase['seconds'] + $measurement['seconds'], 'calls' => $phase['calls'] + 1, 'items' => $phase['items'] + $measurement['items'], 'logicalPeakBytes' => $measurement['logicalPeakBytes'], 'allocatedBytes' => $measurement['allocatedBytes']];
        });
    }

    /** @return array<array-key, mixed> */
    public function report(int $started): array
    {
        return ['seconds' => (hrtime(true) - $started) / 1e9, 'logicalPeakBytes' => memory_get_peak_usage(false), 'allocatedPeakBytes' => memory_get_peak_usage(true), 'phases' => $this->collected];
    }

    public function observe(?callable $observer): void
    {
        $this->observer = $observer === null ? null : Closure::fromCallable($observer);
    }

    /**
     * @template TResult
     *
     * @param  callable(): TResult  $operation
     * @return TResult
     */
    public function measure(string $stage, callable $operation): mixed
    {
        if ($this->observer === null) {
            return $operation();
        }
        $started = hrtime(true);
        $result = $operation();
        $this->record($stage, (hrtime(true) - $started) / 1e9);

        return $result;
    }

    public function record(string $stage, float $seconds, int $items = 0): void
    {
        if ($this->observer !== null) {
            ($this->observer)($stage, ['seconds' => $seconds, 'items' => $items, 'logicalBytes' => memory_get_usage(false), 'allocatedBytes' => memory_get_usage(true), 'logicalPeakBytes' => memory_get_peak_usage(false)]);
        }
    }
}
