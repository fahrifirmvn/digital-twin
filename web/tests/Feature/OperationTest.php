<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\OperationMaintenance;
use App\Models\SimCommand;
use App\Models\SimRun;
use App\Models\User;
use App\Services\RunResultStore;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
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

    public function test_day_result_is_carried_but_next_day_only_starts_when_requested(): void
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

        $this->postJson('/operasi/lanjut')->assertOk()->assertJsonPath('watch_day', 2)->assertJsonPath('target_status', 'running');
        $this->assertSame(2, SimRun::count());
        Http::assertSent(fn ($req) => ($req['day'] ?? null) === 2 && ($req['date'] ?? null) === '2026-11-04' && ($req['carry']['line_sku'] ?? null) === 'UHT');
        Http::assertSent(fn ($req) => ($req['day'] ?? null) === 2 && $req['live'] === true && $req['speed'] == 1);
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
        $this->getJson('/operasi/state')->assertJsonPath('watch_day', 2)->assertJsonPath('live', null);

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

    /** Dua hari selesai dan tidak boleh direvisi; hari 3 belum dimulai. */
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

    public function test_planning_next_day_does_not_rewrite_finished_runs_or_hashes(): void
    {
        $c = $this->operationWithDayAhead();
        $this->assertSame(3, $c->current_day);
        $oldRun = $this->runOfDay($c, 2);
        $oldHash = $c->days()->where('day_no', 2)->value('hash');

        $this->livePlan($c)->assertCreated()->assertJsonPath('day', 3)->assertJsonPath('maintenance.status', 'planned')
            ->assertJsonPath('maintenance.planned.0.asset', 'TK-RAW-2');

        $c->refresh();
        $day2 = $c->days()->where('day_no', 2)->firstOrFail();
        $this->assertSame('closed', $day2->status);
        $this->assertSame($oldRun, $day2->run_id);
        $this->assertSame($oldHash, $day2->hash);
        $this->assertSame(3, $c->current_day);
        $this->getJson('/operasi/state')->assertOk()->assertJsonPath('integrity.ok', true)->assertJsonPath('maintenance.planned.0.asset', 'TK-RAW-2');
    }

    public function test_maintenance_is_refused_while_the_ahead_day_is_computing_and_for_non_managers(): void
    {
        $c = $this->operationWithDayAhead();
        $this->livePlan($c)->assertCreated();
        $this->postJson('/operasi/lanjut')->assertOk();
        $this->livePlan($c, ['asset' => 'TK-RAW-3'])->assertStatus(422);
        $this->assertSame(1, count($c->days()->where('day_no', 3)->firstOrFail()->plan));

        $this->as(Role::Operator);
        $this->livePlan($c, ['asset' => 'TK-RAW-4'])->assertForbidden();
    }

    public function test_cancelling_a_future_plan_does_not_start_or_recompute_a_run(): void
    {
        $c = $this->operationWithDayAhead();
        $this->livePlan($c)->assertCreated();
        $count = SimRun::count();
        $this->deleteJson("/campaigns/{$c->id}/maintenance/0")->assertOk()->assertJsonPath('maintenance.status', 'planned');
        $this->assertSame([], $c->days()->where('day_no', 3)->firstOrFail()->plan);
        $this->assertSame($count, SimRun::count());
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

    private function maintenanceBody(int $run, array $over = []): array
    {
        return $over + ['request_id' => (string) Str::uuid(), 'run_id' => $run, 'asset' => 'TK-RAW-1',
            'mode' => 'now', 'duration_min' => 120, 'reason' => 'Servis langsung'];
    }

    private function fakeLiveEngine(array $responses): void
    {
        Http::swap(new Factory);
        Http::fake($responses);
    }

    public function test_live_maintenance_is_durable_idempotent_and_does_not_fork(): void
    {
        $this->as(Role::Ppic)->postJson('/operasi/lanjut')->assertOk();
        $c = Campaign::firstOrFail();
        $run = $this->runOfDay($c, 1);
        $this->fakeLiveEngine(['engine.test/*/maintenance' => Http::response(['command_id' => 1, 'start_min' => 42.5], 200)]);
        $body = $this->maintenanceBody($run);
        $this->postJson('/operasi/maintenance', $body)->assertCreated()->assertJsonPath('command.status', 'accepted');
        $this->postJson('/operasi/maintenance', $body)->assertCreated();
        $this->assertSame(1, OperationMaintenance::count());
        $this->assertSame(1, SimCommand::count());
        $this->assertSame(1, SimRun::count());
        $this->assertSame(42.5, SimCommand::sole()->minute);
        Http::assertSent(fn ($r) => str_ends_with($r->url(), '/maintenance') && $r['start_min'] === null && $r['request_id'] === $body['request_id']);
        $this->postJson('/operasi/maintenance', [...$body, 'duration_min' => 240])->assertUnprocessable();
        $this->as(Role::Observer)->postJson('/operasi/maintenance', $this->maintenanceBody($run))->assertForbidden();
    }

    public function test_future_schedule_waits_for_selected_day_and_cannot_change_closed_history(): void
    {
        $this->as(Role::Ppic)->postJson('/operasi/lanjut');
        $c = Campaign::firstOrFail();
        $run = $this->runOfDay($c, 1);
        $body = $this->maintenanceBody($run, ['mode' => 'scheduled', 'day' => 2, 'start_min' => 600]);
        $this->postJson('/operasi/maintenance', $body)->assertCreated()->assertJsonPath('command.status', 'scheduled');
        $this->assertSame(1, SimRun::count());
        $this->finish($run, 1);
        $hash = $c->days()->where('day_no', 1)->value('hash');
        $this->postJson('/operasi/maintenance', $this->maintenanceBody($run, ['mode' => 'scheduled', 'day' => 1, 'start_min' => 700]))->assertUnprocessable();
        $this->postJson('/operasi/maintenance', $this->maintenanceBody($run))->assertUnprocessable();
        $this->postJson('/operasi/lanjut')->assertOk()->assertJsonPath('live.day', 2);
        $next = $this->runOfDay($c, 2);
        $this->assertSame($next, OperationMaintenance::sole()->run_id);
        $this->assertSame($hash, $c->days()->where('day_no', 1)->value('hash'));
        Http::assertSent(fn ($r) => ($r['day'] ?? null) === 2 && $r['commands'][0]['request_id'] === $body['request_id'] && $r['commands'][0]['minute'] == 600);
    }

    public function test_live_failures_are_explicit_and_retry_uses_the_same_command_id(): void
    {
        $this->as(Role::Ppic)->postJson('/operasi/lanjut');
        $c = Campaign::firstOrFail();
        $run = $this->runOfDay($c, 1);
        $body = $this->maintenanceBody($run);
        $this->fakeLiveEngine(['engine.test/*/maintenance' => Http::sequence()->push(['detail' => 'Engine belum siap'], 503)->push(['command_id' => 1, 'start_min' => 50], 200)]);
        $this->postJson('/operasi/maintenance', $body)->assertUnprocessable()->assertJsonPath('errors.engine.0', 'Engine belum siap');
        $this->assertSame('uncertain', OperationMaintenance::sole()->status);
        $this->assertSame(0, SimCommand::count());
        $this->postJson('/operasi/maintenance', $body)->assertCreated();
        $this->assertSame('accepted', OperationMaintenance::sole()->status);
        $this->assertSame(1, SimCommand::count());
    }

    public function test_active_replay_follows_engine_cursor_and_never_uses_saved_finished_data(): void
    {
        $this->as(Role::Ppic)->postJson('/operasi/lanjut');
        $run = SimRun::sole();
        $this->fakeLiveEngine(['engine.test/*/live*' => Http::response(['minute' => 50, 'speed' => 5, 'status' => 'running',
            'events' => [['seq' => 4, 'sim_time' => '2026-11-03T06:50:00Z', 'payload' => ['type' => 'sim.clock', 'speed' => 5, 'paused' => false]]]], 200)]);
        $this->getJson("/runs/{$run->id}/replay?after=3")->assertOk()->assertJsonPath('live.minute', 50)->assertJsonPath('events.0.seq', 4);
        Http::assertSent(fn ($r) => str_contains($r->url(), '/live') && $r['after'] == 3);
        $this->fakeLiveEngine(['engine.test/*/live*' => Http::response(['detail' => 'run not found'], 404)]);
        $this->getJson("/runs/{$run->id}/replay")->assertStatus(503)->assertJsonPath('message', 'run not found');
        $this->postJson('/operasi/speed', ['run_id' => $run->id, 'speed' => -5])->assertUnprocessable();
        $this->postJson('/operasi/speed', ['run_id' => $run->id + 1, 'speed' => 20])->assertUnprocessable();
    }

    public function test_maintenance_lifecycle_cannot_be_downgraded_by_relay_retries(): void
    {
        $this->as(Role::Ppic)->postJson('/operasi/lanjut');
        $run = SimRun::sole();
        $this->fakeLiveEngine(['engine.test/*/maintenance' => Http::response(['command_id' => 1, 'start_min' => 42.5], 200)]);
        $body = $this->maintenanceBody($run->id);
        $this->postJson('/operasi/maintenance', $body)->assertCreated();
        $event = fn ($status) => ['run_id' => $run->id, 'sim_time' => '2026-11-03T07:00:00Z',
            'payload' => ['type' => 'maintenance.status', 'request_id' => $body['request_id'], 'status' => $status]];
        $store = app(RunResultStore::class);
        $store->syncMaintenanceEvents($run->id, [$event('maintenance'), $event('waiting_safe'), $event('completed'), $event('maintenance')]);
        $this->assertSame('completed', OperationMaintenance::sole()->status);
    }

    public function test_day_three_running_accepts_immediate_maintenance_on_day_three_not_day_four(): void
    {
        $c = $this->operationWithDayAhead();
        $this->postJson('/operasi/lanjut')->assertOk()->assertJsonPath('live.day', 3);
        $run = $this->runOfDay($c, 3);
        $this->fakeLiveEngine(['engine.test/*/maintenance' => Http::response(['command_id' => 1, 'start_min' => 360], 200)]);
        $this->postJson('/operasi/maintenance', $this->maintenanceBody($run))
            ->assertCreated()->assertJsonPath('command.day_no', 3)->assertJsonPath('command.run_id', $run);
        $this->assertSame(3, SimRun::count());
        $this->assertSame('running', $c->days()->where('day_no', 3)->value('status'));
        $this->assertSame(0, $c->days()->where('day_no', 4)->count());
        $this->get("/twin?run={$run}")->assertOk()->assertSee('Hari 3');
        $previous = $this->runOfDay($c, 2);
        $this->get("/twin?run={$previous}")->assertOk()->assertSee('Riwayat · putar ulang');
    }
}
