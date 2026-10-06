<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;

final class WriteGateway
{
    private bool $active = false;

    public function __construct(private SyncDatabase $database, private ExportRegistry $registry, private RevisionStore $revisions) {}

    public function transaction(ActorContext $actor, callable $handler): mixed
    {
        $connection = $this->database->connection();
        if ($this->active || $connection->transactionLevel() !== 0) {
            throw new ProtocolException('unsupported_query', 'Gateway must own the outer transaction and stream lock order.');
        }

        return $connection->transaction(function () use ($actor, $handler, $connection): mixed {
            $this->active = true;
            try {
                $connection->table('synloquent_streams')->insertOrIgnore(['stream' => $actor->stream(), 'sequence' => 0, 'retention_floor' => 0]);
                $stream = $connection->table('synloquent_streams')->where('stream', $actor->stream())->lockForUpdate()->first();
                $context = new WriteContext($actor, $this->registry, $this->revisions, $this->database);
                try {
                    $result = $handler($context);
                } finally {
                    $context->close();
                }
                if ($context->changes() !== []) {
                    $sequence = (int) $stream->sequence + 1;
                    $connection->table('synloquent_streams')->where('stream', $actor->stream())->update(['sequence' => $sequence]);
                    $connection->table('synloquent_publications')->insert(['stream' => $actor->stream(), 'sequence' => $sequence, 'changes' => CanonicalJson::encode($context->changes()), 'created_at' => now()]);
                }
                foreach ($context->effects() as $effect) {
                    $connection->table('synloquent_effects')->insertOrIgnore(['stream' => $actor->stream(), 'name' => $effect['name'], 'idempotency_key' => $effect['idempotencyKey'], 'payload' => CanonicalJson::encode($effect['payload']), 'attempts' => 0, 'created_at' => now()]);
                }

                return $result;
            } finally {
                $this->active = false;
            }
        }, 3);
    }
}
