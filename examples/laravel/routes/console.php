<?php

use App\Models\Category;
use App\Models\Country;
use App\Models\Image;
use App\Models\Item;
use App\Models\ItemType;
use App\Models\Location;
use App\Models\Note;
use App\Models\Salespoint;
use App\Models\Series;
use App\Models\Tag;
use App\Models\User;
use Illuminate\Support\Facades\Artisan;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

Artisan::command('synloquent:seed-example', function (): void {
    User::updateOrCreate(['id' => 1], ['tenant_id' => 1, 'name' => 'Synthetic actor one']);
    User::updateOrCreate(['id' => 2], ['tenant_id' => 1, 'name' => 'Synthetic actor two']);
    $actor = new ActorContext('1', '1', 'epoch-1', '1', User::find(1), 'example-device');
    app(WriteGateway::class)->transaction($actor, function (WriteContext $context): void {
        $category = Category::firstOrCreate(['title' => 'Stationery'], ['tenant_id' => 1]);
        $context->capture($category);
        $country = Country::firstOrCreate(['title' => 'Example country'], ['tenant_id' => 1]);
        $itemType = ItemType::firstOrCreate(['title' => 'Product'], ['tenant_id' => 1]);
        $series = Series::firstOrCreate(['title' => 'Everyday collection'], ['tenant_id' => 1]);
        $location = Location::firstOrCreate(['title' => 'Example warehouse'], ['tenant_id' => 1, 'country_id' => $country->id]);
        $salespoint = Salespoint::firstOrCreate(['title' => 'Example shop'], ['tenant_id' => 1, 'location_id' => $location->id]);
        foreach ([$country, $itemType, $series, $location, $salespoint] as $model) {
            $context->capture($model);
        }
        foreach ([['Notebook', '12.50', true], ['Water bottle', '7.25', false], ['Pencil case', '12.50', true]] as $index => [$title, $price, $active]) {
            $item = Item::firstOrCreate(['title' => $title], ['tenant_id' => 1, 'category_id' => $category->id, 'price' => $price, 'active' => $active, 'quantity' => $index + 1, 'metadata' => ['region' => 'synthetic']]);
            $item->forceFill(['item_type_id' => $itemType->id, 'series_id' => $series->id, 'location_id' => $location->id, 'labels' => $index === 0 ? [null, true, 1, 'synthetic'] : ($index === 1 ? null : [])]);
            $item->save();
            $context->capture($item);
            $image = Image::firstOrCreate(['item_id' => $item->id, 'url' => 'https://example.invalid/product-'.$index.'.jpg'], ['tenant_id' => 1]);
            $context->capture($image);
        }
        $tag = Tag::firstOrCreate(['title' => 'Everyday'], ['tenant_id' => 1]);
        $context->capture($tag);
        $first = Item::where('title', 'Notebook')->firstOrFail();
        $first->tags()->syncWithoutDetaching([$tag->id => ['position' => 1]]);
        $context->captureRelation($first, 'tags');
        $first->classifications()->syncWithoutDetaching([$tag->id => ['position' => 2]]);
        $context->captureRelation($first, 'classifications');
        $first->salespoints()->syncWithoutDetaching([$salespoint->id => ['position' => 1]]);
        $context->captureRelation($first, 'salespoints');
        foreach ([['item', $first->id, 'Synthetic item note'], ['category', $category->id, 'Synthetic category note']] as [$type, $identity, $body]) {
            $note = Note::firstOrCreate(['notable_type' => $type, 'notable_id' => $identity, 'body' => $body], ['tenant_id' => 1]);
            $context->capture($note);
        }
    });
    $this->info('Synthetic fixture seeded.');
});
