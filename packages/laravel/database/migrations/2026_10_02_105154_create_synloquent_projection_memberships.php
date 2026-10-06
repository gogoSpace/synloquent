<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('synloquent_projection_states', function (Blueprint $table): void {
            $table->string('scope', 64)->primary();
            $table->string('stream', 64)->index();
            $table->unsignedBigInteger('initialized_sequence');
            $table->unsignedBigInteger('current_sequence');
        });
        Schema::create('synloquent_projection_memberships', function (Blueprint $table): void {
            $table->string('scope', 64);
            $table->string('key', 64);
            $table->unsignedBigInteger('sequence');
            $table->unsignedBigInteger('valid_until')->nullable();
            $table->text('state')->nullable();
            $table->primary(['scope', 'key', 'sequence']);
            $table->index(['scope', 'valid_until']);
            $table->foreign('scope')->references('scope')->on('synloquent_projection_states')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('synloquent_projection_memberships');
        Schema::dropIfExists('synloquent_projection_states');
    }
};
