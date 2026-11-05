<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimRun;
use App\Models\User;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

// Memakai contoh hasil nyata dari Engine (contracts/run-result.sample.json) agar kontrak tidak menyimpang.
class RunResultTest extends TestCase
{
    use RefreshDatabase;

    private const TOKEN = ['X-Internal-Token' => 'secret'];

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);
    }

    private function sample(): array
    {
        return json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
    }

    private function makeRun(string $status = 'running'): SimRun
    {
        return SimRun::forceCreate(['id' => 1, 'kind' => 'live', 'seed' => 1, 'status' => $status]);
    }

    public function test_requires_token_and_known_run(): void
    {
        $this->makeRun();
        $this->postJson('/internal/runs/1/result', $this->sample())->assertUnauthorized();
        $this->postJson('/internal/runs/99/result', $this->sample(), self::TOKEN)->assertNotFound();
    }

    public function test_persists_complete_result_atomically(): void
    {
        $this->makeRun();
        $r = $this->sample();

        $this->postJson('/internal/runs/1/result', $r, self::TOKEN)->assertOk()->assertJson(['status' => 'recorded']);

        $run = SimRun::find(1);
        $this->assertSame('finished', $run->status);
        $this->assertSame(json_decode(json_encode($r), true), $run->result_payload);
        $this->assertNotNull($run->scenario_id);
        $this->assertSame(count($r['tankers']), DB::table('tankers')->count());
        $this->assertSame(count($r['batches']), DB::table('batches')->count());
        $this->assertSame(count($r['transfers']), DB::table('transfer_events')->count());
        $this->assertSame(count($r['gates']), DB::table('gate_decisions')->count());
        $this->assertSame(count($r['events']), DB::table('sim_events')->count());
        $this->assertSame(
            collect($r['batches'])->sum(fn ($b) => count($b['parents'])),
            DB::table('batch_lineage')->count(),
        );
        $kpi = json_decode(DB::table('scenarios')->value('kpi_result'), true);
        $this->assertSame(0, $kpi['false_accept']);
        // Setiap batch yang punya transfer di Engine punya baris transfer di DB.
        $this->assertSame(
            collect($r['transfers'])->pluck('batch_code')->unique()->count(),
            DB::table('transfer_events')->distinct()->count('batch_id'),
        );
    }

    public function test_internal_result_get_requires_token_and_returns_persisted_payload(): void
    {
        $this->makeRun();
        $result = $this->sample();
        $this->postJson('/internal/runs/1/result', $result, self::TOKEN)->assertOk();

        $this->getJson('/internal/runs/1/result')->assertUnauthorized();
        $this->getJson('/internal/runs/1/result', self::TOKEN)
            ->assertOk()
            ->assertJsonPath('run_id', 1)
            ->assertJsonPath('status', 'finished')
            ->assertJsonPath('tankers.0.code', $result['tankers'][0]['code']);
    }

    public function test_persists_ai_predictions_and_rejects_invalid_probability(): void
    {
        $this->makeRun();
        $r = $this->sample();
        $this->assertNotNull($r['ai'] ?? null, 'sampel kontrak harus memuat ai');

        $bad = $r;
        $bad['ai']['trucks'][0]['qc_release_prob'] = 1.5;
        $this->postJson('/internal/runs/1/result', $bad, self::TOKEN)->assertUnprocessable();

        $this->postJson('/internal/runs/1/result', $r, self::TOKEN)->assertOk();
        $ai = SimRun::find(1)->ai_result;
        $this->assertSame('DATA SINTETIS', $ai['label']);
        $this->assertCount(count($r['tankers']), $ai['trucks']);
        $this->assertArrayHasKey('risk_score', $ai['anomaly']);
    }

    public function test_result_without_ai_still_recorded(): void
    {
        $this->makeRun();
        $r = $this->sample();
        unset($r['ai']);

        $this->postJson('/internal/runs/1/result', $r, self::TOKEN)->assertOk();
        $this->assertNull(SimRun::find(1)->ai_result);
    }

    public function test_repeated_delivery_is_idempotent(): void
    {
        $this->makeRun();
        $this->postJson('/internal/runs/1/result', $this->sample(), self::TOKEN)->assertOk();
        $before = DB::table('sim_events')->count();

        $this->postJson('/internal/runs/1/result', $this->sample(), self::TOKEN)
            ->assertOk()->assertJson(['status' => 'already_recorded']);
        $this->assertSame($before, DB::table('sim_events')->count());
    }

    public function test_result_may_arrive_while_run_is_still_pending(): void
    {
        $this->makeRun('pending');
        $this->postJson('/internal/runs/1/result', $this->sample(), self::TOKEN)->assertOk();
        $this->assertSame('finished', SimRun::find(1)->status);
    }

    public function test_dangling_references_are_rejected_without_partial_writes(): void
    {
        $this->makeRun();
        $r = $this->sample();
        $r['transfers'][0]['batch_code'] = 'NOPE';

        $this->postJson('/internal/runs/1/result', $r, self::TOKEN)->assertUnprocessable();
        $this->assertSame('running', SimRun::find(1)->status);
        $this->assertSame(0, DB::table('batches')->count());
    }

    public function test_unknown_farm_and_wrong_run_id_are_rejected(): void
    {
        $this->makeRun();
        $r = $this->sample();
        $r['tankers'][0]['farm_code'] = 'FRM-99';
        $this->postJson('/internal/runs/1/result', $r, self::TOKEN)->assertUnprocessable();

        $r = $this->sample();
        $r['run_id'] = 2;
        $this->postJson('/internal/runs/1/result', $r, self::TOKEN)->assertUnprocessable();
    }

    public function test_failed_run_is_recorded(): void
    {
        $this->makeRun();
        $this->postJson('/internal/runs/1/result', ['status' => 'failed', 'run_id' => 1, 'error' => 'boom'], self::TOKEN)->assertOk();

        $run = SimRun::find(1);
        $this->assertSame('failed', $run->status);
        $this->assertSame('boom', $run->error);
    }

    public function test_replay_serves_stored_events_in_order_to_permitted_roles_only(): void
    {
        $this->makeRun();
        $r = $this->sample();
        $this->postJson('/internal/runs/1/result', $r, self::TOKEN)->assertOk();

        $res = $this->actingAs(User::factory()->role(Role::Ppic)->create())->getJson('/runs/1/replay')->assertOk();
        $this->assertSame(range(0, count($r['events']) - 1), array_column($res->json('events'), 'seq'));
        $this->assertSame('sim.clock', $res->json('events.0.p.type'));
        $this->assertSame(0, $res->json('kpi.false_accept'));

        $this->actingAs(User::factory()->role(Role::Driver)->create())->getJson('/runs/1/replay')->assertForbidden();
    }
}
