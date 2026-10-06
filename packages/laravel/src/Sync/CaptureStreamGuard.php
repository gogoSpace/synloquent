<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\ProtocolException;

final class CaptureStreamGuard
{
    public function __construct(private ExportRegistry $registry, private SyncDatabase $database) {}

    public function ensure(Model $model, ActorContext $actor): void
    {
        if ($model->getConnection()->getName() !== $this->database->connection()->getName()) {
            throw new ProtocolException('unsupported_query', 'Atomic referential capture must use one database connection.');
        }
        $resource = $this->registry->get($this->registry->nameForClass($model::class));
        if ($resource->captureStream($model) !== $actor->stream()) {
            throw new ProtocolException('unsupported_query', 'Automatic referential capture requires one verified stream.');
        }
    }
}
