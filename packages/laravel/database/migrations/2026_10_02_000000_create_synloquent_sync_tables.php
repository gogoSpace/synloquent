<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('synloquent_streams', function (Blueprint $table): void {
            $table->string('stream', 64)->primary();
            $table->unsignedBigInteger('sequence')->default(0);
            $table->unsignedBigInteger('retention_floor')->default(0);
        });
        Schema::create('synloquent_publications', function (Blueprint $table): void {
            $table->string('stream', 64);
            $table->unsignedBigInteger('sequence');
            $table->text('changes');
            $table->timestampTz('created_at');
            $table->primary(['stream', 'sequence']);
            $table->foreign('stream')->references('stream')->on('synloquent_streams')->cascadeOnDelete();
        });
        Schema::create('synloquent_revisions', function (Blueprint $table): void {
            $table->string('stream', 64);
            $table->string('model', 128);
            $table->string('identity', 128);
            $table->unsignedBigInteger('revision');
            $table->primary(['stream', 'model', 'identity']);
        });
        Schema::create('synloquent_receipts', function (Blueprint $table): void {
            $table->string('partition', 64);
            $table->string('operation_id', 128);
            $table->string('payload_hash', 64);
            $table->string('status', 16);
            $table->text('response');
            $table->timestampTz('created_at');
            $table->primary(['partition', 'operation_id']);
        });
        Schema::create('synloquent_aliases', function (Blueprint $table): void {
            $table->string('partition', 64);
            $table->string('model', 128);
            $table->string('local_identity', 128);
            $table->string('identity', 128);
            $table->primary(['partition', 'model', 'local_identity']);
        });
        Schema::create('synloquent_subscriptions', function (Blueprint $table): void {
            $table->string('subscription', 64)->primary();
            $table->string('stream', 64)->index();
            $table->text('membership');
            $table->unsignedBigInteger('sequence');
            $table->string('authorization_generation', 128);
        });
        Schema::create('synloquent_snapshots', function (Blueprint $table): void {
            $table->string('hash', 64)->primary();
            $table->string('stream', 64)->index();
            $table->unsignedBigInteger('sequence');
            $table->text('document');
            $table->unsignedBigInteger('byte_size');
            $table->timestampTz('created_at');
        });
        Schema::create('synloquent_effects', function (Blueprint $table): void {
            $table->id();
            $table->string('stream', 64);
            $table->string('name', 128);
            $table->string('idempotency_key', 128);
            $table->text('payload');
            $table->unsignedInteger('attempts')->default(0);
            $table->timestampTz('delivered_at')->nullable();
            $table->timestampTz('created_at');
            $table->unique(['stream', 'name', 'idempotency_key']);
        });
    }

    public function down(): void
    {
        foreach (['synloquent_effects', 'synloquent_snapshots', 'synloquent_subscriptions', 'synloquent_aliases', 'synloquent_receipts', 'synloquent_revisions', 'synloquent_publications', 'synloquent_streams'] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
