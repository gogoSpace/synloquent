<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Query\Builder;
use Pdo\Pgsql;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;

final class MembershipIndex
{
    public function __construct(private SyncDatabase $database, private StageProfiler $profiler) {}

    /** @param iterable<array<array-key, mixed>> $membership */
    public function initializeStream(iterable $membership, string $scope, string $stream, int $sequence): void
    {
        $connection = $this->database->connection();
        $state = $connection->table('synloquent_projection_states')->where('scope', $scope)->first();
        if ($state === null) {
            $connection->table('synloquent_projection_states')->insert(['scope' => $scope, 'stream' => $stream, 'initialized_sequence' => $sequence, 'current_sequence' => $sequence]);
        }
        $seenTable = null;
        if ($state !== null) {
            $seenTable = '__synloquent_seen_'.bin2hex(random_bytes(8));
            $connection->statement('CREATE TEMPORARY TABLE '.$seenTable.' (key varchar(64) PRIMARY KEY) ON COMMIT DROP');
        }
        $chunk = [];
        foreach ($membership as $member) {
            $key = $this->key($member);
            $chunk[$key] = $member;
            if (count($chunk) === 4000) {
                $this->initializeChunk($chunk, $scope, $sequence, $state === null);
                if ($seenTable !== null) {
                    $connection->table($seenTable)->insert(array_map(static fn (string $key): array => ['key' => $key], array_keys($chunk)));
                }
                $chunk = [];
            }
        }
        if ($chunk !== []) {
            $this->initializeChunk($chunk, $scope, $sequence, $state === null);
            if ($seenTable !== null) {
                $connection->table($seenTable)->insert(array_map(static fn (string $key): array => ['key' => $key], array_keys($chunk)));
            }
        }
        if ($state !== null) {
            $missing = [];
            foreach ($this->at($scope, (int) $state->current_sequence)->whereNotNull('state')->whereNotExists(fn ($query) => $query->selectRaw('1')->from($seenTable)->whereColumn($seenTable.'.key', 'synloquent_projection_memberships.key'))->select('key')->cursor() as $row) {
                $missing[$row->key] = null;
                if (count($missing) === 4000) {
                    $this->advance($missing, $scope, $sequence);
                    $missing = [];
                }
            }
            if ($missing !== []) {
                $this->advance($missing, $scope, $sequence);
            }
            $this->advance([], $scope, $sequence);
            $connection->statement('DROP TABLE '.$seenTable);
        }
    }

    /** @param array<string, array<array-key, mixed>> $chunk */
    private function initializeChunk(array $chunk, string $scope, int $sequence, bool $fresh): void
    {
        if (! $fresh) {
            $this->advance($chunk, $scope, $sequence);

            return;
        }
        $rows = $this->profiler->measure('membership.rowPreparation', function () use ($chunk, $scope, $sequence): array {
            $rows = [];
            foreach ($chunk as $key => $member) {
                $rows[] = ['scope' => $scope, 'key' => $key, 'sequence' => $sequence, 'valid_until' => null, 'state' => CanonicalJson::encode($member)];
            }

            return $rows;
        });
        $this->insert($rows);
    }

    public function scope(ActorContext $actor, string $dataset, string $fingerprint, ?string $generation = null): string
    {
        return CanonicalJson::hash([$actor->partition(), $dataset, $fingerprint, $generation ?? $actor->authorizationGeneration]);
    }

    /** @param array<array-key, array<array-key, mixed>> $membership */
    public function initialize(array $membership, string $scope, string $stream, int $sequence): void
    {
        $state = $this->database->connection()->table('synloquent_projection_states')->where('scope', $scope)->first();
        if ($state === null) {
            $connection = $this->database->connection();
            $connection->table('synloquent_projection_states')->insert(['scope' => $scope, 'stream' => $stream, 'initialized_sequence' => $sequence, 'current_sequence' => $sequence]);
            foreach (array_chunk($membership, 4000) as $chunk) {
                $rows = [];
                foreach ($chunk as $member) {
                    $rows[] = ['scope' => $scope, 'key' => $this->key($member), 'sequence' => $sequence, 'valid_until' => null, 'state' => CanonicalJson::encode($member)];
                }
                $this->insert($rows);
            }

            return;
        }
        $changes = [];
        $existing = $this->all($scope, (int) $state->current_sequence);
        $current = [];
        foreach ($membership as $member) {
            $current[$this->key($member)] = $member;
        }
        foreach ($current as $key => $member) {
            if (($existing[$key]['hash'] ?? null) !== $member['hash']) {
                $changes[$key] = $member;
            }
        }
        foreach (array_diff_key($existing, $current) as $key => $member) {
            $changes[$key] = null;
        }
        if ($changes !== [] && $sequence <= (int) $state->current_sequence) {
            throw new ProtocolException('cursor_expired', 'Projection changed without a new captured publication.');
        }
        $this->database->connection()->table('synloquent_projection_states')->insertOrIgnore(['scope' => $scope, 'stream' => $stream, 'initialized_sequence' => $sequence, 'current_sequence' => $sequence]);
        $this->advance($changes, $scope, $sequence);
    }

    public function ready(string $scope, int $sequence): bool
    {
        return $this->database->connection()->table('synloquent_projection_states')->where('scope', $scope)->where('initialized_sequence', '<=', $sequence)->where('current_sequence', '>=', $sequence)->exists();
    }

    /**
     * @param  array<array-key, array<array-key, mixed>>  $descriptors
     * @return array<string, array<array-key, mixed>>
     */
    public function lookup(array $descriptors, string $scope, int $sequence): array
    {
        $keys = array_values(array_unique(array_map($this->key(...), $descriptors)));
        if ($keys === []) {
            return [];
        }
        $rows = $this->versions($keys, $scope, $sequence);
        $result = [];
        foreach ($rows as $row) {
            if ($row->state !== null) {
                $result[$row->key] = json_decode($row->state, true, flags: JSON_THROW_ON_ERROR);
            }
        }

        return $result;
    }

    public function exceeds(string $scope, int $sequence, int $maximum): bool
    {
        $bounded = $this->at($scope, $sequence)->whereNotNull('state')->limit($maximum + 1)->select('key');

        return $this->database->connection()->query()->fromSub($bounded, '__bounded_members')->count() > $maximum;
    }

    /** @return array<string, array<array-key, mixed>> */
    public function all(string $scope, int $sequence): array
    {
        $result = [];
        foreach ($this->at($scope, $sequence)->whereNotNull('state')->select(['key', 'state'])->cursor() as $row) {
            $result[$row->key] = json_decode($row->state, true, flags: JSON_THROW_ON_ERROR);
        }

        return $result;
    }

    /** @param array<string, array<array-key, mixed>|null> $changes */
    public function advance(array $changes, string $scope, int $sequence): void
    {
        $connection = $this->database->connection();
        foreach (array_chunk($changes, 4000, true) as $chunk) {
            $active = collect($this->versions(array_keys($chunk), $scope, null))->keyBy('key');
            $rows = [];
            foreach ($chunk as $key => $member) {
                $encoded = $member === null ? null : CanonicalJson::encode($member);
                $old = $active->get($key);
                if ($old !== null && $old->state === $encoded) {
                    continue;
                }
                if ($old !== null && (int) $old->sequence >= $sequence) {
                    throw new ProtocolException('cursor_expired', 'A projection version cannot change at an existing publication cursor.');
                }
                $rows[] = ['scope' => $scope, 'key' => $key, 'sequence' => $sequence, 'valid_until' => null, 'state' => $encoded];
            }
            if ($rows !== []) {
                $connection->table('synloquent_projection_memberships')->where('scope', $scope)->whereIn('key', array_column($rows, 'key'))->whereNull('valid_until')->update(['valid_until' => $sequence]);
                $connection->table('synloquent_projection_memberships')->insert($rows);
            }
        }
        $connection->table('synloquent_projection_states')->where('scope', $scope)->where('current_sequence', '<', $sequence)->update(['current_sequence' => $sequence]);
    }

    /** @param list<array<string, mixed>> $rows */
    private function insert(array $rows): void
    {
        $connection = $this->database->connection();
        $driver = $connection->getPdo();
        if (! $driver instanceof Pgsql) {
            $connection->table('synloquent_projection_memberships')->insert($rows);

            return;
        }
        $null = '__synloquent_copy_null__';
        $lines = $this->profiler->measure('membership.copyPreparation', function () use ($rows, $null): array {
            $lines = [];
            foreach ($rows as $row) {
                $values = [];
                foreach (['scope', 'key', 'sequence', 'valid_until', 'state'] as $field) {
                    $values[] = $row[$field] === null ? $null : str_replace(['\\', "\t", "\n", "\r"], ['\\\\', '\\t', '\\n', '\\r'], (string) $row[$field]);
                }
                $lines[] = implode("\t", $values);
            }

            return $lines;
        });
        $table = $connection->getQueryGrammar()->wrapTable('synloquent_projection_memberships');
        $started = microtime(true);
        if (! $this->profiler->measure('membership.copy', fn () => $driver->copyFromArray($table, $lines, "\t", $null, 'scope,key,sequence,valid_until,state'))) {
            throw new ProtocolException('validation_failed', 'Projection membership copy failed.');
        }
        $connection->logQuery('COPY '.$table.' (scope,key,sequence,valid_until,state) FROM STDIN', [], (microtime(true) - $started) * 1000);
    }

    /**
     * @param  list<string>  $keys
     * @return list<\stdClass>
     */
    private function versions(array $keys, string $scope, ?int $sequence): array
    {
        $candidates = implode(', ', array_fill(0, count($keys), '(?::varchar)'));
        $condition = $sequence === null ? 'valid_until IS NULL' : 'sequence <= ?';
        $bindings = [...$keys, $scope, ...($sequence === null ? [] : [$sequence])];

        return $this->database->connection()->select('SELECT candidates.key, version.state, version.sequence FROM (VALUES '.$candidates.') AS candidates(key) CROSS JOIN LATERAL (SELECT state, sequence FROM synloquent_projection_memberships WHERE scope = ? AND key = candidates.key AND '.$condition.' ORDER BY sequence DESC LIMIT 1) AS version', $bindings);
    }

    /** @param array<array-key, mixed> $descriptor */
    public function key(array $descriptor): string
    {
        return CanonicalJson::hash([$descriptor['model'], $descriptor['id'] ?? $descriptor['parentId'], $descriptor['relation'] ?? null]);
    }

    private function at(string $scope, int $sequence): Builder
    {
        return $this->database->connection()->table('synloquent_projection_memberships')->where('scope', $scope)->where('sequence', '<=', $sequence)->where(fn ($query) => $query->whereNull('valid_until')->orWhere('valid_until', '>', $sequence));
    }

    public function prune(string $stream, int $floor): void
    {
        $scopes = $this->database->connection()->table('synloquent_projection_states')->where('stream', $stream)->select('scope');
        $this->database->connection()->table('synloquent_projection_memberships')->whereIn('scope', $scopes)->where('valid_until', '<=', $floor)->delete();
    }
}
