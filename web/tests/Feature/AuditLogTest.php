<?php

namespace Tests\Feature;

use App\Services\AuditLogger;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class AuditLogTest extends TestCase
{
    // Tabel dibuat lewat migrasi (bukan transaksi) agar trigger dan lock berperilaku seperti produksi.
    use DatabaseMigrations;

    protected function setUp(): void
    {
        parent::setUp();

        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Audit log memakai trigger PostgreSQL.');
        }
    }

    public function test_chain_links_rows_and_verifies_intact(): void
    {
        $audit = app(AuditLogger::class);
        $audit->record('user', '1', 'gate.decided', ['gate' => 'G2']);
        $audit->record('llm', null, 'tool.call', ['tool' => 'get_state']);

        [$a, $b] = DB::table('audit_logs')->orderBy('id')->get()->all();

        $this->assertSame(str_repeat('0', 64), $a->prev_hash);
        $this->assertSame($a->hash, $b->prev_hash);
        $this->assertNull($audit->firstBrokenId());
    }

    public function test_update_delete_and_truncate_are_rejected(): void
    {
        app(AuditLogger::class)->record('system', null, 'x');

        foreach ([
            fn () => DB::table('audit_logs')->update(['action' => 'y']),
            fn () => DB::table('audit_logs')->delete(),
            fn () => DB::statement('TRUNCATE audit_logs'),
        ] as $mutation) {
            try {
                $mutation();
                $this->fail('Mutasi audit_logs seharusnya ditolak.');
            } catch (QueryException $e) {
                $this->assertStringContainsString('append-only', $e->getMessage());
            }
        }
    }
}
