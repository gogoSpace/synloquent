<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->string('name');
        });
        Schema::create('categories', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->string('title')->unique();
            $table->timestampsTz();
        });
        Schema::create('items', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->foreignId('category_id')->nullable()->constrained()->restrictOnDelete();
            $table->string('title')->unique();
            $table->decimal('price', 12, 2)->default(0);
            $table->boolean('active')->default(true);
            $table->integer('quantity')->default(0);
            $table->json('metadata')->nullable();
            $table->timestampsTz();
            $table->index(['active', 'price', 'id']);
        });
        Schema::create('images', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->foreignId('item_id')->constrained()->cascadeOnDelete();
            $table->string('url');
            $table->timestampsTz();
            $table->unique(['item_id', 'url']);
        });
        Schema::create('tags', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->string('title')->unique();
            $table->timestampsTz();
        });
        Schema::create('item_tag', function (Blueprint $table): void {
            $table->foreignId('item_id')->constrained()->cascadeOnDelete();
            $table->foreignId('tag_id')->constrained()->cascadeOnDelete();
            $table->integer('position')->default(0);
            $table->primary(['item_id', 'tag_id']);
            $table->index(['item_id', 'position']);
        });
        Schema::create('collection_entries', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->index();
            $table->foreignId('actor_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('item_id')->constrained()->restrictOnDelete();
            $table->date('acquired_on')->nullable();
            $table->text('note')->nullable();
            $table->timestampsTz();
            $table->unique(['actor_id', 'item_id']);
        });
    }

    public function down(): void
    {
        foreach (['collection_entries', 'item_tag', 'tags', 'images', 'items', 'categories', 'users'] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
