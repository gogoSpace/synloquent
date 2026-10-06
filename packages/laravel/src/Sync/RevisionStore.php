<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

final class RevisionStore
{
    public function __construct(private SyncDatabase $database) {}

    /** @return array<string, string> */
    public function all(string $stream): array
    {
        $revisions = [];
        foreach ($this->database->connection()->table('synloquent_revisions')->where('stream', $stream)->get() as $revision) {
            $revisions[$revision->model.':'.$revision->identity] = (string) $revision->revision;
        }

        return $revisions;
    }

    public function get(string $stream, string $model, string $identity): string
    {
        return (string) ($this->database->connection()->table('synloquent_revisions')->where(['stream' => $stream, 'model' => $model, 'identity' => $identity])->value('revision') ?? 0);
    }

    /**
     * @param  list<array<array-key, mixed>>  $records
     * @return list<array<array-key, mixed>>
     */
    public function hydrate(array $records, string $stream): array
    {
        $identities = [];
        foreach ($records as $record) {
            $identities[$record['model']][$record['id']] = $record['id'];
        }
        $revisions = [];
        foreach ($identities as $model => $keys) {
            foreach (array_chunk(array_values($keys), 1000) as $chunk) {
                foreach ($this->database->connection()->table('synloquent_revisions')->where(['stream' => $stream, 'model' => $model])->whereIn('identity', $chunk)->get(['identity', 'revision']) as $row) {
                    $revisions[$model.':'.$row->identity] = (string) $row->revision;
                }
            }
        }
        foreach ($records as &$record) {
            $record['revision'] = $revisions[$record['model'].':'.$record['id']] ?? '0';
        }

        return $records;
    }

    public function advance(string $stream, string $model, string $identity): string
    {
        $revision = (int) $this->get($stream, $model, $identity) + 1;
        $this->database->connection()->table('synloquent_revisions')->updateOrInsert(['stream' => $stream, 'model' => $model, 'identity' => $identity], ['revision' => $revision]);

        return (string) $revision;
    }

    /**
     * @param  list<array{model: string, identity: string}>  $identities
     * @return array<string, string>
     */
    public function advanceMany(string $stream, array $identities): array
    {
        $revisions = [];
        $connection = $this->database->connection();
        $table = $connection->getQueryGrammar()->wrapTable('synloquent_revisions');
        foreach (array_chunk($identities, 1000) as $chunk) {
            $bindings = [];
            foreach ($chunk as $identity) {
                array_push($bindings, $stream, $identity['model'], $identity['identity']);
            }
            $sql = 'INSERT INTO '.$table.' AS revision_rows (stream, model, identity, revision) VALUES '.implode(', ', array_fill(0, count($chunk), '(?, ?, ?, 1)')).' ON CONFLICT (stream, model, identity) DO UPDATE SET revision = revision_rows.revision + 1 RETURNING model, identity, revision';
            foreach ($connection->selectFromWriteConnection($sql, $bindings) as $row) {
                $revisions[$row->model.':'.$row->identity] = (string) $row->revision;
            }
        }

        return $revisions;
    }
}
