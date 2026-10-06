<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Protocol;

use JsonException;
use Opis\JsonSchema\Errors\ErrorFormatter;
use Opis\JsonSchema\Validator;
use stdClass;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Sync\StageProfiler;

final class ProtocolValidator
{
    private Validator $validator;

    /** @var array<string, int> */
    private array $catalogLimits = [];

    private ?CatalogSchemaCompiler $catalogCompiler;

    public function __construct(private StageProfiler $profiler)
    {
        $this->validator = new Validator;
        $this->validator->setMaxErrors(5);
        foreach (glob(__DIR__.'/Schemas/*.schema.json') ?: [] as $path) {
            $schema = json_decode(file_get_contents($path), flags: JSON_THROW_ON_ERROR);
            $this->validator->resolver()->registerFile($schema->{'$id'}, $path);
        }
        $snapshot = json_decode(file_get_contents(__DIR__.'/Schemas/snapshot.schema.json'), flags: JSON_THROW_ON_ERROR);
        foreach (['records', 'relationSets'] as $section) {
            $definition = clone $snapshot->properties->{$section};
            $definition->{'$id'} = 'https://synloquent.local/protocol/1/snapshot-'.$section.'.schema.json';
            $definition->{'$schema'} = $snapshot->{'$schema'};
            $this->catalogLimits[$section] = $definition->maxItems;
            $this->validator->resolver()->registerRaw($definition, $definition->{'$id'});
        }
        try {
            $this->catalogCompiler = new CatalogSchemaCompiler;
        } catch (\RuntimeException) {
            $this->catalogCompiler = null;
        }
    }

    public function validateEnvelope(string $content): void
    {
        if (strlen($content) > config('synloquent.max_request_bytes', 1048576)) {
            throw new ProtocolException('validation_failed', 'Protocol request exceeds byte limit.');
        }
        try {
            $envelope = json_decode($content, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new ProtocolException('validation_failed', 'Protocol request is not valid JSON.');
        }
        if (! ValueCodec::finite($envelope)) {
            throw new ProtocolException('validation_failed', 'Protocol values must contain finite numbers.');
        }
        $this->validate('envelope', $envelope);
        if (! $envelope instanceof stdClass) {
            throw new ProtocolException('validation_failed', 'Envelope must be an object.');
        }
        if ($envelope->kind === 'query') {
            $this->validate('query', $envelope->payload);
        } elseif ($envelope->kind === 'push') {
            if (array_keys(get_object_vars($envelope->payload)) !== ['operations'] || ! is_array($envelope->payload->operations ?? null) || count($envelope->payload->operations) > config('synloquent.max_batch_size', 100)) {
                throw new ProtocolException('validation_failed', 'Push requires a bounded operations array.');
            }
            foreach ($envelope->payload->operations as $operation) {
                $this->validate('operation', $operation);
            }
        } elseif (in_array($envelope->kind, ['pull', 'snapshot'], true)) {
            $keys = array_keys(get_object_vars($envelope->payload));
            $allowed = $envelope->kind === 'snapshot' ? ['dataset', 'cursor', 'delivery'] : ['dataset', 'cursor'];
            if (array_diff($keys, $allowed) !== [] || ! is_string($envelope->payload->dataset ?? null) || (isset($envelope->payload->cursor) && ! is_string($envelope->payload->cursor)) || (isset($envelope->payload->delivery) && $envelope->payload->delivery !== 'parts-v1')) {
                throw new ProtocolException('validation_failed', 'Invalid dataset request.');
            }
        } elseif ($envelope->kind === 'command') {
            if (array_diff(array_keys(get_object_vars($envelope->payload)), ['name', 'operationId', 'arguments']) !== [] || ! is_string($envelope->payload->name ?? null) || ! is_string($envelope->payload->operationId ?? null) || ! ($envelope->payload->arguments ?? null) instanceof stdClass) {
                throw new ProtocolException('validation_failed', 'Invalid command request.');
            }
        }
    }

    public function validate(string $schema, mixed $value): void
    {
        $result = $this->validator->validate($value, 'https://synloquent.local/protocol/1/'.$schema.'.schema.json');
        if (! $result->isValid()) {
            $error = $result->error();
            throw new ProtocolException('validation_failed', 'Protocol schema validation failed.', ['schema' => $schema, 'errors' => $error === null ? [] : (new ErrorFormatter)->formatFlat($error)]);
        }
    }

    /** @return list<stdClass> */
    public function validateCatalogChunk(string $section, string $encoded, int $total): array
    {
        if (! isset($this->catalogLimits[$section]) || $total > $this->catalogLimits[$section]) {
            throw new ProtocolException('validation_failed', 'Snapshot section exceeds the protocol row limit.');
        }
        $value = $this->profiler->measure('protocol.catalogDecode', fn () => json_decode($encoded, flags: JSON_THROW_ON_ERROR));
        if ($this->catalogCompiler === null || ! $this->catalogCompiler->valid($section, $value)) {
            $this->validate('snapshot-'.$section, $value);
        }

        return $value;
    }
}
