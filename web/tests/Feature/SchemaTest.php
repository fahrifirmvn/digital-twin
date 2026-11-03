<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class SchemaTest extends TestCase
{
    use RefreshDatabase;

    public function test_core_domain_tables_exist(): void
    {
        foreach ([
            'farms', 'bays', 'tanks', 'process_units', 'skus', 'filling_lines', 'sku_changeover_rules',
            'constraint_sets', 'assumptions', 'scenarios', 'sim_runs', 'tankers', 'lab_tests', 'batches',
            'batch_lineage', 'transfer_events', 'cip_events', 'gate_decisions', 'schedules', 'schedule_versions',
        ] as $table) {
            $this->assertTrue(Schema::hasTable($table), $table);
        }
    }

    public function test_demo_seeders_are_idempotent(): void
    {
        $this->seed();
        $this->seed();

        $this->assertSame(6, User::count());
        $this->assertSame(9, DB::table('assumptions')->count());
    }
}
