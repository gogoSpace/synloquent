<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        foreach (['countries', 'item_types', 'series'] as $name) {
            Schema::create($name, function (Blueprint $table): void {
                $table->id();
                $table->unsignedBigInteger('tenant_id')->index();
                $table->string('title')->unique();
                $table->timestampsTz();
            });
        }
        Schema::create('locations', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->foreignId('country_id')->constrained()->restrictOnDelete();
            $table->string('title');
            $table->timestampsTz();
        });
        Schema::create('salespoints', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->foreignId('location_id')->nullable()->constrained()->nullOnDelete();
            $table->string('title');
            $table->timestampsTz();
        });
        Schema::table('items', function (Blueprint $table): void {
            $table->foreignId('item_type_id')->nullable()->constrained()->nullOnDelete();
            $table->foreignId('series_id')->nullable()->constrained('series')->nullOnDelete();
            $table->foreignId('location_id')->nullable()->constrained()->nullOnDelete();
            $table->string('status')->default('draft');
            $table->string('catalog_code')->nullable();
            $table->date('published_on')->nullable();
            $table->timestampTz('released_at')->nullable();
            $table->double('latitude')->nullable();
        });
        Schema::create('item_salespoint', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('item_id')->constrained()->cascadeOnDelete();
            $table->foreignId('salespoint_id')->constrained()->cascadeOnDelete();
            $table->integer('position')->default(0);
            $table->unique(['item_id', 'salespoint_id']);
            $table->index(['item_id', 'position']);
        });
        foreach (['uuid_records', 'ulid_records', 'external_records'] as $name) {
            Schema::create($name, function (Blueprint $table) use ($name): void {
                $table->string($name === 'external_records' ? 'external_key' : 'id')->primary();
                $table->unsignedBigInteger('tenant_id')->index();
                $table->string('title');
                $table->timestampsTz();
            });
        }
    }

    public function down(): void
    {
        foreach (['item_salespoint', 'uuid_records', 'ulid_records', 'external_records'] as $name) {
            Schema::dropIfExists($name);
        }
        Schema::table('items', function (Blueprint $table): void {
            $table->dropConstrainedForeignId('item_type_id');
            $table->dropConstrainedForeignId('series_id');
            $table->dropConstrainedForeignId('location_id');
            $table->dropColumn(['status', 'catalog_code', 'published_on', 'released_at', 'latitude']);
        });
        foreach (['salespoints', 'locations', 'series', 'item_types', 'countries'] as $name) {
            Schema::dropIfExists($name);
        }
    }
};
