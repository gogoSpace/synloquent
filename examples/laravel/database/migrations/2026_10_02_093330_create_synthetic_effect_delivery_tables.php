<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('synthetic_effect_attempts', function (Blueprint $table): void {
            $table->id();
            $table->string('destination');
            $table->string('idempotency_key');
        });
        Schema::create('synthetic_effect_deliveries', function (Blueprint $table): void {
            $table->string('destination');
            $table->string('idempotency_key');
            $table->text('payload');
            $table->primary(['destination', 'idempotency_key']);
        });
        Schema::create('synthetic_effect_non_idempotent_deliveries', function (Blueprint $table): void {
            $table->id();
            $table->string('destination');
            $table->text('payload');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('synthetic_effect_non_idempotent_deliveries');
        Schema::dropIfExists('synthetic_effect_deliveries');
        Schema::dropIfExists('synthetic_effect_attempts');
    }
};
