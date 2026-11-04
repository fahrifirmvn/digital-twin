<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\SimRun;
use App\Models\User;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

// Operasi harian: satu pabrik yang berjalan hari demi hari, keadaan terbawa, hari lewat bisa diputar ulang.
class OperationTest extends TestCase
{
    use RefreshDatabase;

    private int $engineStatus = 201;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);
        Http::fake(fn () => Http::response([], $this->engineStatus));
    }

    private function as(Role $role): static
    {
        $this->actingAs(User::factory()->role($role)->create());

        return $this;
    }

    /** Engine melaporkan hari berjalan selesai, lengkap dengan ringkasan dan keadaan terbawa. */
    private function finish(int $runId, int $day): void
    {
        $r = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
        $r['run_id'] = $runId;
        $r['day'] = $day;
        $r['day_summary'] = ['day' => $day, 'date' => '2026-11-0'.(2 + $day), 'received' => 12, 'rejected' => 1, 'released' => 9];
        $r['carry_out'] = ['line_sku' => 'UHT', 'fouling_min' => 120.0, 'fg_stock_ton' => 40.0 * $day];
        $this->postJson("/internal/runs/{$runId}/result", $r, ['X-Internal-Token' => 'secret'])->assertOk();
    }

    private function runOfDay(Campaign $c, int $day): int
    {
        return (int) $c->days()->where('day_no', $day)->firstOrFail()->run_id;
    }

    public function test_advance_creates_the_single_operation_and_starts_day_one_with_the_fixed_date(): void
    {
        $this->as(Role::Ppic);
        $this->postJson('/operasi/lanjut')->assertOk()->assertJsonPath('target_day', 1)->assertJsonPath('target_status', 'running');

        $c = Campaign::firstOrFail();
        $this->assertSame('2026-11-03', $c->start_date->toDateString());
        $this->postJson('/operasi/lanjut')->assertOk()->assertJsonPath('target_status', 'running'); // idempoten
        $this->assertSame(1, Campaign::count());
        $this->assertSame(1, SimRun::count());
        Http::assertSent(fn ($req) => ($req['day'] ?? null) === 1 && ($req['date'] ?? null) === '2026-11-03' && ! isset($req['carry']));
    }

    public function test_day_result_is_stored_and_carried_into_the_next_day_which_is_prepared_one_step_ahead(): void
    {
        $this->as(Role::Ppic);
        $this->postJson('/operasi/lanjut');
        $c = Campaign::firstOrFail();
        $this->finish($this->runOfDay($c, 1), 1);

        $d1 = $c->days()->where('day_no', 1)->firstOrFail();
        $this->assertSame('closed', $d1->status);
        $snap = $d1->snapshot();
        $this->assertSame(2, $snap['v']);
        $this->assertSame('UHT', $snap['state']['engine_carry']['line_sku']);
        $this->assertSame(12, $snap['summary']['received']);
        $this->assertSame(1, SimRun::count()); // hari 2 belum disiapkan sebelum hari 1 ditonton

        $this->postJson('/operasi/lanjut')->assertOk()->assertJsonPath('watch_day', 1)->assertJsonPath('target_status', 'running');
        $this->assertSame(2, SimRun::count()); // hari 2 disiapkan satu langkah di depan
        Http::assertSent(fn ($req) => ($req['day'] ?? null) === 2 && ($req['date'] ?? null) === '2026-11-04' && ($req['carry']['line_sku'] ?? null) === 'UHT');
    }

    public function test_default_twin_shows_the_watched_day_and_past_days_replay_by_run_id(): void
    {
        $this->as(Role::Ppic);
        $this->postJson('/operasi/lanjut');
        $c = Campaign::firstOrFail();
        $r1 = $this->runOfDay($c, 1);
        $this->finish($r1, 1);
        $this->postJson('/operasi/lanjut');
        $r2 = $this->runOfDay($c, 2);
        $this->finish($r2, 2);
        $this->postJson('/operasi/lanjut')->assertJsonPath('watch_day', 2);

        $this->get('/twin')->assertOk()->assertSee("data-run-id=\"{$r2}\"", false);
        $this->get("/twin?run={$r1}")->assertOk()->assertSee("data-run-id=\"{$r1}\"", false);
        $this->getJson('/operasi/state')->assertOk()->assertJsonCount(2, 'days')->assertJsonPath('days.0.run_id', $r1)
            ->assertJsonPath('days.1.summary.received', 12)->assertJsonPath('integrity.ok', true);
    }

    public function test_only_managers_advance_but_viewers_read_state_and_driver_cannot(): void
    {
        $this->as(Role::Operator)->postJson('/operasi/lanjut')->assertForbidden();
        $this->getJson('/operasi/state')->assertOk()->assertJsonPath('exists', false);
        $this->as(Role::Driver)->getJson('/operasi/state')->assertForbidden();
    }

    public function test_engine_failure_on_advance_reports_error_and_can_be_retried(): void
    {
        $this->as(Role::Ppic);
        $this->engineStatus = 500;
        $this->postJson('/operasi/lanjut')->assertStatus(422);
        $c = Campaign::firstOrFail();
        $this->assertSame('failed', CampaignDay::where('campaign_id', $c->id)->firstOrFail()->status);

        $this->engineStatus = 201;
        $this->postJson('/operasi/lanjut')->assertOk()->assertJsonPath('target_status', 'running');
    }

    public function test_archived_runs_are_hidden_from_defaults_and_lists(): void
    {
        $this->as(Role::Ppic);
        $old = SimRun::create(['kind' => 'live', 'seed' => 1, 'status' => 'finished', 'config_snapshot' => []]);
        $old->forceFill(['archived_at' => now()])->save();
        $this->get('/twin')->assertOk()->assertDontSee('data-run-id', false);
        $this->get('/runs')->assertOk()->assertDontSee("/runs/{$old->id}\"", false);
    }

    /** Hari 1 ditonton, hari 2 sudah dihitung di depan (belum ditonton), hari 3 direncanakan. */
    private function operationWithDayAhead(): Campaign
    {
        $this->as(Role::Ppic);
        $this->postJson('/operasi/lanjut');
        $c = Campaign::firstOrFail();
        $this->finish($this->runOfDay($c, 1), 1);
        $this->postJson('/operasi/lanjut');
        $this->finish($this->runOfDay($c, 2), 2);

        return $c->refresh();
    }

    private function livePlan(Campaign $c, array $over = [])
    {
        return $this->postJson("/campaigns/{$c->id}/maintenance", $over + ['asset' => 'TK-RAW-2', 'start_min' => 600, 'duration_min' => 120, 'reason' => 'Servis berkala']);
    }

    public function test_maintenance_revises_the_unwatched_day_ahead_and_keeps_the_hash_chain_valid(): void
    {
        $c = $this->operationWithDayAhead();
        $this->assertSame(3, $c->current_day);
        $oldRun = $this->runOfDay($c, 2);
        $oldHash = $c->days()->where('day_no', 2)->value('hash');

        $this->livePlan($c)->assertCreated()->assertJsonPath('day', 2)->assertJsonPath('maintenance.status', 'running')
            ->assertJsonPath('maintenance.planned.0.asset', 'TK-RAW-2');

        $c->refresh();
        $day2 = $c->days()->where('day_no', 2)->firstOrFail();
        $this->assertSame('running', $day2->status);
        $this->assertNotSame($oldRun, $day2->run_id);
        $this->assertNull($day2->hash);
        $this->assertSame(2, $c->current_day);
        $this->assertSame(0, $c->days()->where('day_no', 3)->count());
        $this->assertSame(1, \App\Models\SimCommand::where('run_id', $day2->run_id)->where('kind', 'tank_down')->count());
        $this->assertSame(1, $c->watch_day);
        $this->assertTrue(SimRun::findOrFail($oldRun)->config_snapshot['superseded']);

        $this->finish($day2->run_id, 2);
        $c->refresh();
        $this->assertSame('closed', $c->days()->where('day_no', 2)->value('status'));
        $this->assertNotSame($oldHash, $c->days()->where('day_no', 2)->value('hash'));
        $this->assertSame(3, $c->current_day);
        $this->getJson('/operasi/state')->assertOk()->assertJsonPath('integrity.ok', true)->assertJsonPath('maintenance.planned.0.asset', 'TK-RAW-2');
    }

    public function test_maintenance_is_refused_while_the_ahead_day_is_computing_and_for_non_managers(): void
    {
        $c = $this->operationWithDayAhead();
        $this->livePlan($c)->assertCreated();
        $this->livePlan($c, ['asset' => 'TK-RAW-3'])->assertStatus(422);
        $this->assertSame(1, count($c->days()->where('day_no', 2)->firstOrFail()->plan));

        $this->as(Role::Operator);
        $this->livePlan($c, ['asset' => 'TK-RAW-4'])->assertForbidden();
    }

    public function test_cancelling_a_live_maintenance_recomputes_the_day_without_it(): void
    {
        $c = $this->operationWithDayAhead();
        $this->livePlan($c)->assertCreated();
        $this->finish($this->runOfDay($c, 2), 2);

        $this->deleteJson("/campaigns/{$c->id}/maintenance/0")->assertOk()->assertJsonPath('maintenance.status', 'running');
        $this->assertSame([], $c->days()->where('day_no', 2)->firstOrFail()->plan);
        $this->assertSame(0, \App\Models\SimCommand::where('run_id', $this->runOfDay($c, 2))->count());
    }

    public function test_state_exposes_tank_service_meter_from_the_previous_day_carry(): void
    {
        $this->as(Role::Ppic);
        $this->postJson('/operasi/lanjut');
        $c = Campaign::firstOrFail();
        $runId = $this->runOfDay($c, 1);
        $r = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
        $r['run_id'] = $runId;
        $r['day'] = 1;
        $r['day_summary'] = ['day' => 1, 'date' => '2026-11-03', 'received' => 12, 'rejected' => 1, 'released' => 9];
        $r['carry_out'] = ['line_sku' => 'UHT', 'fouling_min' => 120.0, 'fg_stock_ton' => 40.0, 'tank_cycles' => ['TK-RAW-2' => 10, 'TK-STO-1' => 8, 'TK-RAW-3' => 2]];
        $this->postJson("/internal/runs/{$runId}/result", $r, ['X-Internal-Token' => 'secret'])->assertOk();
        $this->postJson('/operasi/lanjut');

        $tanks = collect($this->getJson('/operasi/state')->assertOk()->json('maintenance.tanks'))->keyBy('asset');
        $this->assertSame(['cycles' => 10, 'state' => 'due'], ['cycles' => $tanks['TK-RAW-2']['cycles'], 'state' => $tanks['TK-RAW-2']['state']]);
        $this->assertSame('near', $tanks['TK-STO-1']['state']);
        $this->assertSame('ok', $tanks['TK-RAW-3']['state']);
        $this->assertSame('ok', $tanks['TK-RAW-1']['state']);
    }
}
