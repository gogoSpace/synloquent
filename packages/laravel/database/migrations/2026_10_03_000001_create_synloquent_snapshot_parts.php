<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('synloquent_snapshot_transfers', function (Blueprint $table): void {
            $table->string('grant', 64)->primary();
            $table->string('metadata_hash', 64);
            $table->text('descriptor');
            $table->string('descriptor_hash', 64);
            $table->timestamp('created_at');
            $table->foreign('grant')->references('grant')->on('synloquent_snapshot_grants')->cascadeOnDelete();
        });
        Schema::create('synloquent_snapshot_parts', function (Blueprint $table): void {
            $table->string('grant', 64);
            $table->unsignedInteger('ordinal');
            $table->string('section', 16);
            $table->unsignedInteger('first_index');
            $table->unsignedInteger('row_count');
            $table->string('hash', 64);
            $table->unsignedInteger('byte_size');
            $table->text('body');
            $table->primary(['grant', 'ordinal']);
            $table->foreign('grant')->references('grant')->on('synloquent_snapshot_transfers')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('synloquent_snapshot_parts');
        Schema::dropIfExists('synloquent_snapshot_transfers');
    }
};
