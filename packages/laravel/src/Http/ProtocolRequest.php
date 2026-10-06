<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Http;

use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Protocol\ProtocolValidator;

final class ProtocolRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<array-key, mixed> */
    public function rules(): array
    {
        return ['protocolVersion' => ['required', 'integer', 'in:1'], 'requestId' => ['required', 'string', 'max:128'], 'kind' => ['required', 'in:manifest,query,push,pull,snapshot,command'], 'schemaFingerprint' => ['required', 'string', 'max:128'], 'session' => ['required', 'array:accountId,tenantId,deviceId,deviceEpoch,generation'], 'session.accountId' => ['required', 'string', 'max:128'], 'session.tenantId' => ['required', 'string', 'max:128'], 'session.deviceId' => ['required', 'string', 'max:128'], 'session.deviceEpoch' => ['required', 'string', 'max:128'], 'session.generation' => ['required', 'integer', 'min:0'], 'payload' => ['present', 'array']];
    }

    /** @return list<callable> */
    public function after(): array
    {
        return [function (Validator $validator): void {
            try {
                $this->container->make(ProtocolValidator::class)->validateEnvelope($this->getContent());
            } catch (ProtocolException $exception) {
                $validator->errors()->add('protocol', $exception->getMessage());
            }
        }];
    }

    protected function failedValidation(Validator $validator): never
    {
        throw new HttpResponseException(response()->json(['error' => ['code' => 'validation_failed', 'message' => 'Invalid protocol envelope.', 'details' => ['fields' => $validator->errors()->toArray()]]], 422));
    }
}
