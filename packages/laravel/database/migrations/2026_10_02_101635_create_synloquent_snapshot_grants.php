<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('synloquent_snapshot_grants', function (Blueprint $table): void {
            $table->string('grant', 64)->primary();
            $table->string('partition', 64);
            $table->string('generation', 64);
            $table->string('hash', 64);
            $table->string('stream', 64);
            $table->unsignedBigInteger('sequence');
            $table->string('authorization_generation');
            $table->string('schema_fingerprint', 64);
            $table->text('metadata');
            $table->string('metadata_hash', 64);
            $table->timestampTz('created_at');
            $table->foreign('hash')->references('hash')->on('synloquent_snapshots')->cascadeOnDelete();
            $table->index(['partition', 'generation', 'hash']);
            $table->index(['stream', 'sequence']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('synloquent_snapshot_grants');
    }
};
