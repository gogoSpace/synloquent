<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('synloquent_relation_revisions', function (Blueprint $table): void {
            $table->string('stream', 64);
            $table->string('model', 128);
            $table->string('relation', 128);
            $table->string('identity', 128);
            $table->unsignedBigInteger('revision');
            $table->primary(['stream', 'model', 'relation', 'identity']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('synloquent_relation_revisions');
    }
};
