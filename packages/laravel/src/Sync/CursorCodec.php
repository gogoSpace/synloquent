<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Contracts\Config\Repository;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;

final class CursorCodec
{
    public function __construct(private Repository $configuration) {}

    public function encode(ActorContext $actor, string $dataset, string $fingerprint, int $sequence): string
    {
        $body = $this->base64(CanonicalJson::encode(['partition' => $actor->partition(), 'dataset' => $dataset, 'fingerprint' => $fingerprint, 'authorizationGeneration' => $actor->authorizationGeneration, 'sequence' => $sequence]));

        return $body.'.'.$this->base64(hash_hmac('sha256', $body, $this->secret(), true));
    }

    /** @return array<array-key, mixed> */
    public function decode(string $cursor, ActorContext $actor, string $dataset, string $fingerprint): array
    {
        $parts = explode('.', $cursor);
        if (count($parts) !== 2 || ! hash_equals($this->base64(hash_hmac('sha256', $parts[0], $this->secret(), true)), $parts[1])) {
            throw new ProtocolException('schema_mismatch', 'Invalid cursor signature.');
        }
        $decoded = base64_decode(strtr($parts[0], '-_', '+/'), true);
        if ($decoded === false) {
            throw new ProtocolException('schema_mismatch', 'Invalid cursor encoding.');
        }
        try {
            $payload = json_decode($decoded, true, flags: JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ProtocolException('schema_mismatch', 'Invalid cursor document.');
        }
        if (! is_array($payload) || ($payload['partition'] ?? null) !== $actor->partition() || ($payload['dataset'] ?? null) !== $dataset || ($payload['fingerprint'] ?? null) !== $fingerprint || ! is_string($payload['authorizationGeneration'] ?? null) || ! is_int($payload['sequence'] ?? null) || $payload['sequence'] < 0) {
            throw new ProtocolException('schema_mismatch', 'Cursor scope changed.');
        }

        return $payload;
    }

    private function secret(): string
    {
        $secret = $this->configuration->get('synloquent.cursor_secret');
        if (! is_string($secret) || strlen($secret) < 16) {
            throw new ProtocolException('schema_mismatch', 'Configure a stable cursor signing secret.');
        }

        return $secret;
    }

    private function base64(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
