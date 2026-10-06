<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Contracts\Validation\Factory;
use Synloquent\Laravel\Contracts\ServerCommand;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;

final class CommandAction
{
    public function __construct(private SyncDatabase $database, private WriteGateway $gateway, private CommandRegistry $commands, private Factory $validation, private ValueCodec $values) {}

    /**
     * @param  array<array-key, mixed>  $request
     * @return array<array-key, mixed>
     */
    public function execute(array $request, ActorContext $actor): array
    {
        $command = $this->commands->get($request['name'] ?? '');
        if (! $command->authorize($actor)) {
            throw new ProtocolException('forbidden_operation', 'Command policy denied the action.', [], 403);
        }
        if (! is_string($request['operationId'] ?? null) || strlen($request['operationId']) > 128) {
            throw new ProtocolException('validation_failed', 'Command requires a stable operationId.');
        }
        $arguments = $request['arguments'] ?? [];
        if (array_diff(array_keys($arguments), array_keys($command->arguments())) !== []) {
            throw new ProtocolException('validation_failed', 'Unknown command argument.');
        }
        foreach ($arguments as $field => $value) {
            $this->values->validate($value, $command->arguments()[$field], $field);
        }
        $validator = $this->validation->make($this->values->validationData($arguments), $command->argumentRules());
        if ($validator->fails()) {
            throw new ProtocolException('validation_failed', 'Command arguments are invalid.', ['fields' => $validator->errors()->toArray()]);
        }
        $arguments = $this->values->validatedValues($validator->validated(), $arguments, $command->arguments());

        return $this->gateway->transaction($actor, function (WriteContext $context) use ($request, $actor, $command, $arguments): array {
            $table = $this->database->connection()->table('synloquent_receipts');
            $existing = (clone $table)->where(['partition' => $actor->partition(), 'operation_id' => $request['operationId']])->first();
            if ($existing !== null) {
                if (! hash_equals($existing->payload_hash, CanonicalJson::hash($request))) {
                    throw new ProtocolException('idempotency_mismatch', 'Command identity was reused with changed arguments.');
                }

                $historical = json_decode($existing->response, flags: JSON_THROW_ON_ERROR);
                $result = $command->replay(get_object_vars($historical->result), $actor);
                if ($result !== null) {
                    $this->validateResult($command, $result);
                }

                return ['operationId' => $request['operationId'], 'status' => 'accepted', 'replayed' => true, ...($result !== null ? ['result' => $result] : [])];
            }
            $result = $command->execute($arguments, $context);
            $this->validateResult($command, $result);
            $response = ['operationId' => $request['operationId'], 'status' => 'accepted', 'result' => $result];
            $table->insert(['partition' => $actor->partition(), 'operation_id' => $request['operationId'], 'payload_hash' => CanonicalJson::hash($request), 'status' => 'accepted', 'response' => CanonicalJson::encode($response), 'created_at' => now()]);

            return $response;
        });
    }

    /** @param array<array-key, mixed> $result */
    private function validateResult(ServerCommand $command, array $result): void
    {
        if (array_diff(array_keys($result), array_keys($command->result())) !== []) {
            throw new ProtocolException('validation_failed', 'Command returned undeclared fields.');
        }
        foreach ($result as $field => $value) {
            $this->values->validate($value, $command->result()[$field], $field);
        }
        if ($this->validation->make($this->values->validationData($result), $command->resultRules())->fails()) {
            throw new ProtocolException('validation_failed', 'Command returned an invalid result.');
        }
    }
}
