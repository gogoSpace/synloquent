<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('synloquent_projection_memberships', function (Blueprint $table): void {
            $table->dropIndex('synloquent_projection_memberships_scope_valid_until_index');
        });
    }

    public function down(): void
    {
        Schema::table('synloquent_projection_memberships', function (Blueprint $table): void {
            $table->index(['scope', 'valid_until']);
        });
    }
};
