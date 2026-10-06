<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('synloquent_aliases', function (Blueprint $table): void {
            $table->string('operation_id', 128)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('synloquent_aliases', function (Blueprint $table): void {
            $table->dropColumn('operation_id');
        });
    }
};
