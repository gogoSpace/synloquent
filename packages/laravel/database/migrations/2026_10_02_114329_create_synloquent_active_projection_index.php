<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('CREATE UNIQUE INDEX synloquent_projection_active ON synloquent_projection_memberships (scope, key) WHERE valid_until IS NULL');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX synloquent_projection_active');
    }
};
