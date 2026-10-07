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
            return;
        }
        foreach (['uuid_records', 'ulid_records', 'external_records'] as $name) {
            Schema::table($name, static function (Blueprint $table) use ($name): void {
                $table->string($name === 'external_records' ? 'external_key' : 'id')->collation('utf8mb4_nopad_bin')->change();
            });
        }
    }

    public function down(): void {}
};
