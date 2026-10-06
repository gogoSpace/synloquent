<?php

use App\Commands\IncreaseQuantity;
use App\Commands\InspectItemLocked;
use App\Effects\SyntheticAtLeastOnceDestination;
use App\Effects\SyntheticIdempotentDestination;
use App\Exports\CategoryExport;
use App\Exports\CollectionEntryExport;
use App\Exports\CountryExport;
use App\Exports\ExampleActorResolver;
use App\Exports\ExternalRecordExport;
use App\Exports\ImageExport;
use App\Exports\ItemExport;
use App\Exports\ItemTypeExport;
use App\Exports\LocationExport;
use App\Exports\NoteExport;
use App\Exports\SalespointExport;
use App\Exports\SeriesExport;
use App\Exports\TagExport;
use App\Exports\UlidRecordExport;
use App\Exports\UuidRecordExport;
use App\Scopes\ActivePriced;
use App\Scopes\MetadataContains;

return ['profile_snapshots' => true, 'profile_directory' => env('SYNLOQUENT_PROFILE_DIRECTORY'), 'additional_capabilities' => ['json.object-contains.remote.v1'], 'effects' => [SyntheticIdempotentDestination::class, SyntheticAtLeastOnceDestination::class], 'commands' => [IncreaseQuantity::class, InspectItemLocked::class], 'scopes' => [ActivePriced::class, MetadataContains::class], 'exports' => [CategoryExport::class, ItemExport::class, ImageExport::class, TagExport::class, CollectionEntryExport::class, NoteExport::class, CountryExport::class, ItemTypeExport::class, SeriesExport::class, LocationExport::class, SalespointExport::class, UuidRecordExport::class, UlidRecordExport::class, ExternalRecordExport::class], 'actor_resolver' => ExampleActorResolver::class, 'middleware' => [], 'capture_contract' => 'gateway', 'cursor_secret' => env('SYNLOQUENT_CURSOR_SECRET', 'synthetic-example-cursor-secret-change-in-real-host')];
