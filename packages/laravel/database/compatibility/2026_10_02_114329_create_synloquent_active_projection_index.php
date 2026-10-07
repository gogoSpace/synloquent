<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (DB::connection()->getDriverName() === 'pgsql') {
            DB::statement('CREATE UNIQUE INDEX synloquent_projection_active ON synloquent_projection_memberships (scope, key) WHERE valid_until IS NULL');

            return;
        }
        Schema::table('synloquent_projection_memberships', function (Blueprint $table): void {
            $table->unsignedTinyInteger('active_version')->nullable()->virtualAs('CASE WHEN valid_until IS NULL THEN 1 ELSE NULL END');
            $table->unique(['scope', 'key', 'active_version'], 'synloquent_projection_active');
        });
    }

    public function down(): void
    {
        if (DB::connection()->getDriverName() === 'pgsql') {
            DB::statement('DROP INDEX synloquent_projection_active');

            return;
        }
        Schema::table('synloquent_projection_memberships', function (Blueprint $table): void {
            $table->dropUnique('synloquent_projection_active');
            $table->dropColumn('active_version');
        });
    }
};
