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
        foreach (['publications' => ['changes'], 'receipts' => ['response'], 'subscriptions' => ['membership'], 'snapshots' => ['document'], 'effects' => ['payload'], 'snapshot_grants' => ['metadata'], 'projection_memberships' => ['state'], 'snapshot_transfers' => ['descriptor'], 'snapshot_parts' => ['body']] as $tableName => $columns) {
            Schema::table('synloquent_'.$tableName, function (Blueprint $table) use ($columns, $tableName): void {
                foreach ($columns as $column) {
                    $table->longText($column)->nullable($tableName === 'projection_memberships')->change();
                }
            });
        }
        foreach (['revisions' => ['model', 'identity'], 'relation_revisions' => ['model', 'relation', 'identity'], 'receipts' => ['operation_id'], 'aliases' => ['model', 'local_identity', 'identity', 'operation_id'], 'effects' => ['name', 'idempotency_key'], 'subscriptions' => ['authorization_generation'], 'snapshot_grants' => ['authorization_generation']] as $tableName => $columns) {
            Schema::table('synloquent_'.$tableName, function (Blueprint $table) use ($columns, $tableName): void {
                foreach ($columns as $column) {
                    $table->string($column, $tableName === 'snapshot_grants' ? 255 : 128)->collation('utf8mb4_nopad_bin')->nullable($tableName === 'aliases' && $column === 'operation_id')->change();
                }
            });
        }
    }

    public function down(): void
    {
        // Keep widened payloads and exact identities during rollback to avoid losing stored data.
    }
};
