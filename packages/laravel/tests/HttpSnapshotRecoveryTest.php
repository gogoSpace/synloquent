<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Item;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class HttpSnapshotRecoveryTest extends TestCase
{
    public function test_public_http_stream_waits_for_concurrent_http_writer_and_preserves_anchored_tail(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), static fn (): null => null);
        $writer = $this->server();
        $snapshot = $this->server();
        $writing = null;
        $reading = null;
        try {
            $writing = $this->request($writer, 'push', ['operations' => [$this->operation('http-writer', 'create', ['title' => 'Actual HTTP concurrent write'])]], ['X-Synloquent-Test-Barrier: writer']);
            $this->waitFor(fn (): bool => is_file($writer['directory'].'/locked'), $writer['directory']);
            $reading = $this->request($snapshot, 'snapshot', ['dataset' => 'catalog']);
            $activity = null;
            $this->waitFor(function () use (&$activity): bool {
                $activity = DB::selectOne("select wait_event_type, query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%synloquent_streams%for update%' limit 1");

                return $activity !== null;
            });
            $this->assertSame('Lock', $activity->wait_event_type);
            $this->assertSame(0, Item::count());
            file_put_contents($writer['directory'].'/release', 'release');
            $receipt = $this->finish($writing)['payload']['receipts'][0];
            $writing = null;
            $document = $this->finish($reading)['payload'];
            $reading = null;
            $this->assertSame('accepted', $receipt['status']);
            $this->assertEquals([...$receipt['canonical'], 'localIdentity' => 'local-http-writer'], $document['records'][0]);
            $this->assertSame([], $this->app->make(PullAction::class)->execute($document['cursor'], 'catalog', $this->actor())['batches']);
            $update = $this->request($writer, 'push', ['operations' => [$this->operation('http-tail', 'update', ['title' => 'Actual HTTP anchored tail'], ['id' => $receipt['canonical']['id'], 'expectedRevision' => $receipt['canonical']['revision']])]]);
            $this->assertSame('accepted', $this->finish($update)['payload']['receipts'][0]['status']);
            $tail = $this->app->make(PullAction::class)->execute($document['cursor'], 'catalog', $this->actor());
            $this->assertSame('Actual HTTP anchored tail', $tail['batches'][0]['changes'][0]['record']['attributes']['title']);
            $this->assertSame('Actual HTTP concurrent write', $document['records'][0]['attributes']['title']);
        } finally {
            if ($writing !== null) {
                $this->closeRequest($writing);
            }
            if ($reading !== null) {
                $this->closeRequest($reading);
            }
            $this->closeServer($writer);
            $this->closeServer($snapshot);
        }
    }

    public function test_public_http_catalog_membership_and_persistence_failures_roll_back_and_clean_spools(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            for ($offset = 0; $offset < 5000; $offset += 500) {
                $rows = [];
                for ($index = $offset; $index < $offset + 500; $index++) {
                    $rows[] = ['tenant_id' => 1, 'title' => 'Failure fixture '.$index, 'created_at' => now(), 'updated_at' => now()];
                }
                DB::table('items')->insert($rows);
            }
            $context->invalidateAuthorization();
        });
        $server = $this->server();
        $revision = '0';
        try {
            foreach (['catalog', 'membership', 'persistence'] as $stage) {
                $request = $this->request($server, 'snapshot', ['dataset' => 'catalog'], ['X-Synloquent-Test-Failure: '.$stage]);
                $failure = $this->finish($request);
                $this->assertSame('invalid_snapshot', $failure['error']['code']);
                $this->assertStringContainsString($stage, $failure['error']['message']);
                foreach (['synloquent_snapshots', 'synloquent_snapshot_grants', 'synloquent_projection_states', 'synloquent_projection_memberships', 'synloquent_subscriptions'] as $table) {
                    $this->assertSame(0, DB::table($table)->count(), $stage.' left '.$table);
                }
                $this->assertSame([], glob($server['directory'].'/php*'));
                $this->assertSame(0, DB::selectOne("select count(*) as total from pg_stat_activity where datname = current_database() and state = 'idle in transaction'")->total);
                $writing = $this->request($server, 'push', ['operations' => [$this->operation('after-failure-'.$stage, 'update', ['title' => 'Lock released '.$stage], ['id' => '1', 'expectedRevision' => $revision])]]);
                $receipt = $this->finish($writing)['payload']['receipts'][0];
                $this->assertSame('accepted', $receipt['status']);
                $revision = $receipt['canonical']['revision'];
            }
            $complete = $this->finish($this->request($server, 'snapshot', ['dataset' => 'catalog']))['payload'];
            $this->assertCount(5000, $complete['records']);
            $this->assertSame(1, DB::table('synloquent_snapshot_grants')->count());
            $this->assertSame([], glob($server['directory'].'/php*'));
        } finally {
            $this->closeServer($server);
        }
    }

    private function server(): array
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errorNumber, $errorMessage);
        if ($socket === false) {
            throw new \RuntimeException($errorMessage);
        }
        $address = stream_socket_get_name($socket, false);
        fclose($socket);
        $directory = sys_get_temp_dir().'/synloquent-http-'.bin2hex(random_bytes(8));
        mkdir($directory, 0700);
        $environment = [...getenv(), 'SYNLOQUENT_TEST_DATABASE' => DB::connection()->getDatabaseName(), 'SYNLOQUENT_TEST_ARTIFACTS' => $directory];
        $process = proc_open([PHP_BINARY, '-d', 'memory_limit=128M', '-d', 'sys_temp_dir='.$directory, '-S', $address, __DIR__.'/Fixtures/http-stream-router.php'], [0 => ['pipe', 'r'], 1 => ['file', $directory.'/server.log', 'a'], 2 => ['file', $directory.'/server.log', 'a']], $pipes, dirname(__DIR__, 3), $environment);
        if ($process === false) {
            throw new \RuntimeException('Cannot start the owned HTTP fixture.');
        }
        $server = ['process' => $process, 'pipes' => $pipes, 'address' => $address, 'directory' => $directory];
        try {
            $this->waitFor(function () use ($address): bool {
                $connection = @stream_socket_client('tcp://'.$address, $errorNumber, $errorMessage, 0.1);
                if ($connection === false) {
                    return false;
                } fclose($connection);

                return true;
            });

            return $server;
        } catch (\Throwable $exception) {
            $this->closeServer($server);
            throw $exception;
        }
    }

    private function request(array $server, string $kind, array $payload, array $headers = []): array
    {
        $envelope = ['protocolVersion' => 1, 'requestId' => 'http-stream-'.$kind, 'kind' => $kind, 'schemaFingerprint' => $this->app->make(ManifestBuilder::class)->build()['fingerprint'], 'session' => ['accountId' => '1', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 1], 'payload' => $payload];
        $command = ['curl', '--silent', '--show-error', '--max-time', '20', '--header', 'Content-Type: application/json', '--header', 'Authorization: Bearer synthetic-actor-1', '--data-binary', '@-'];
        foreach ($headers as $header) {
            array_push($command, '--header', $header);
        }
        $command[] = 'http://'.$server['address'].'/synloquent/v1/protocol';
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if ($process === false) {
            throw new \RuntimeException('Cannot start the owned HTTP request.');
        }
        fwrite($pipes[0], json_encode($envelope, JSON_THROW_ON_ERROR));
        fclose($pipes[0]);

        return ['process' => $process, 'pipes' => $pipes];
    }

    private function finish(array $request): array
    {
        $content = stream_get_contents($request['pipes'][1]);
        $errors = stream_get_contents($request['pipes'][2]);
        fclose($request['pipes'][1]);
        fclose($request['pipes'][2]);
        $this->assertSame(0, proc_close($request['process']), $errors);
        $this->assertSame('', $errors);

        return json_decode($content, true, flags: JSON_THROW_ON_ERROR);
    }

    private function closeRequest(array $request): void
    {
        if (! is_resource($request['process'])) {
            return;
        }
        $state = proc_get_status($request['process']);
        if ($state['running']) {
            proc_terminate($request['process']);
        }
        foreach ([1, 2] as $index) {
            if (is_resource($request['pipes'][$index])) {
                fclose($request['pipes'][$index]);
            }
        }
        proc_close($request['process']);
    }

    private function closeServer(array $server): void
    {
        fclose($server['pipes'][0]);
        $state = proc_get_status($server['process']);
        if ($state['running']) {
            proc_terminate($server['process']);
        }
        proc_close($server['process']);
        foreach (glob($server['directory'].'/*') ?: [] as $path) {
            unlink($path);
        }
        rmdir($server['directory']);
    }

    private function waitFor(callable $condition, ?string $diagnostics = null): void
    {
        $deadline = microtime(true) + 8;
        do {
            if ($condition()) {
                return;
            } usleep(1000);
        } while (microtime(true) < $deadline);
        $details = '';
        if ($diagnostics !== null) {
            foreach (glob($diagnostics.'/*') ?: [] as $path) {
                $details .= basename($path).': '.file_get_contents($path)."\n";
            }
        }
        $this->fail('The owned HTTP process did not reach its barrier. '.$details);
    }
}
