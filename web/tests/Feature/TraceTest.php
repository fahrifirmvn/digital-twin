<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimRun;
use App\Models\User;
use App\Services\TraceService;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class TraceTest extends TestCase
{
    use RefreshDatabase;

    private const TOKEN = ['X-Internal-Token' => 'secret'];

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);

        SimRun::forceCreate(['id' => 1, 'kind' => 'live', 'seed' => 1, 'status' => 'running']);
        $sample = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
        $this->postJson('/internal/runs/1/result', $sample, self::TOKEN)->assertOk();
    }

    private function as(Role $role): static
    {
        return $this->actingAs(User::factory()->role($role)->create());
    }

    private function batchId(string $code): int
    {
        return (int) DB::table('batches')->where('code', $code)->value('id');
    }

    public function test_backward_from_fg_reaches_tanker_and_farm(): void
    {
        $t = app(TraceService::class)->trace(1, 'FG-0001');

        $this->assertSame('FG-0001', $t['batch']['code']);
        $this->assertSame(['INT-0001' => 1, 'RAW-RT-001' => 2], collect($t['upstream'])->pluck('depth', 'code')->all());
        $this->assertSame([], $t['downstream']);
        $this->assertSame(['RT-001'], array_column($t['tankers'], 'code'));
        $this->assertNotEmpty($t['tankers'][0]->farm_code);
        $this->assertNotEmpty($t['transfers']);
        $this->assertContains('G1', array_column($t['gates'], 'gate'));
    }

    public function test_forward_from_raw_and_tanker_code_reaches_fg_with_edges_and_dwell(): void
    {
        $t0 = hrtime(true);
        $t = app(TraceService::class)->trace(1, 'RT-001');
        $elapsedMs = (hrtime(true) - $t0) / 1e6;

        $this->assertNotNull($t);
        $this->assertLessThan(50.0, $elapsedMs, 'Trace query must complete under 50 ms');
        $this->assertSame('RT-001', $t['resolved_from_tanker']);
        $this->assertSame('RAW-RT-001', $t['batch']['code']);
        $this->assertSame([], $t['upstream']);
        $this->assertSame(['INT-0001' => 1, 'FG-0001' => 2], collect($t['downstream'])->pluck('depth', 'code')->all());
        $this->assertNotEmpty($t['edges']);
        $this->assertGreaterThan(0, $t['mass_summary']['raw_ton']);
        $this->assertNotEmpty($t['batch']['tanks']);
        $this->assertStringContainsString('WIB', $t['transfers'][0]->clock_wib);
        $dwells = array_values(array_filter(array_map(fn ($tr) => $tr->dwell_min, $t['transfers']), fn ($v) => $v !== null));
        $this->assertNotEmpty($dwells);
    }

    public function test_merge_graph_has_no_duplicates_and_stays_in_run(): void
    {
        // INT-0002 digabung dengan INT-0001 menjadi MIX, lalu MIX menjadi FG-MERGE.
        $mk = fn (string $code, string $type) => DB::table('batches')->insertGetId([
            'run_id' => 1, 'code' => $code, 'type' => $type, 'volume_ton' => 10, 'status' => 'active',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $mix = $mk('MIX-1', 'intermediate');
        $fg = $mk('FG-MERGE', 'fg');
        $link = fn (int $p, int $c) => DB::table('batch_lineage')->insert(['parent_batch_id' => $p, 'child_batch_id' => $c, 'volume_ton' => 5]);
        $link($this->batchId('INT-0001'), $mix);
        $link($this->batchId('INT-0002'), $mix);
        $link($mix, $fg);

        $t = app(TraceService::class)->trace(1, 'FG-MERGE');
        $codes = array_column($t['upstream'], 'code');

        $this->assertSame(count($codes), count(array_unique($codes)));
        $this->assertEqualsCanonicalizing(['MIX-1', 'INT-0001', 'INT-0002', 'RAW-RT-001', 'RAW-RT-002'], $codes);
        $this->assertSame(['RT-001', 'RT-002'], array_column($t['tankers'], 'code'));
        $mixEdges = array_values(array_filter($t['edges'], fn ($e) => $e['child_code'] === 'MIX-1'));
        $this->assertCount(2, $mixEdges);
        $this->assertSame(50.0, $mixEdges[0]['share_pct']);

        $fwd = app(TraceService::class)->trace(1, 'RAW-RT-002');
        $this->assertContains('FG-MERGE', array_column($fwd['downstream'], 'code'));
    }

    public function test_unknown_code_and_other_run_return_null(): void
    {
        $this->assertNull(app(TraceService::class)->trace(1, 'FG-9999'));
        $this->assertNull(app(TraceService::class)->trace(2, 'FG-0001'));
    }

    public function test_page_shows_trace_for_allowed_roles_only(): void
    {
        $this->as(Role::Qa)->get('/trace?run=1&code=fg-0001')
            ->assertOk()
            ->assertSee('RAW-RT-001')
            ->assertSee('RT-001')
            ->assertSee('Peta Aliran Silsilah Batch')
            ->assertSee('Jam Operasional (06:00–06:00)')
            ->assertSee('Keputusan gate');
        $this->as(Role::Qa)->get('/trace?run=1&code=rt-001')
            ->assertOk()
            ->assertSee('Forward Trace')
            ->assertSee('RAW-RT-001')
            ->assertSee('FG-0001');
        $this->as(Role::Ppic)->get('/trace')->assertOk()->assertSee('Contoh kode FG')->assertSee('Telusur maju dari truk');
        $this->as(Role::Qa)->get('/trace?run=1&code=NOPE')->assertOk()->assertSee('tidak ditemukan');
        $this->as(Role::Qa)->get('/trace?run=1&code=a%27b')->assertSessionHasErrors('code');

        foreach ([Role::Operator, Role::Driver, Role::Observer] as $role) {
            $this->as($role)->get('/trace')->assertForbidden();
        }
        auth()->logout();
        $this->get('/trace')->assertRedirect('/login');
    }
}
