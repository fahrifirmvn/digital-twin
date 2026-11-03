<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimCommand;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

// Mode Simulasi: cabang what-if dengan log perintah.
class SimulationTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
    }

    private function as(Role $role, string $name = 'Dewi'): static
    {
        return $this->actingAs(User::factory()->role($role)->create(['name' => $name]));
    }

    private function base(string $status = 'finished', array $kpi = ['truck_wait_min' => ['mean' => 20, 'p90' => 30]]): SimRun
    {
        $scenario = DB::table('scenarios')->insertGetId([
            'name' => 't', 'params' => '{}', 'seed' => 3, 'kpi_result' => json_encode($kpi),
            'created_at' => now(), 'updated_at' => now(),
        ]);

        return SimRun::forceCreate([
            'kind' => 'live', 'seed' => 3, 'status' => $status, 'scenario_id' => $scenario,
            'config_snapshot' => ['config' => 'D', 'scenario' => 'normal', 'params' => ['volume_ton' => 320, 'extra_bad' => 1]],
        ]);
    }

    private function body(array $over = []): array
    {
        return $over + ['minute' => 420, 'kind' => 'ster_down', 'reason' => 'Uji ketahanan jadwal'];
    }

    public function test_fork_creates_linked_simulation_run_and_sends_commands_to_engine(): void
    {
        Http::fake(['engine.test/*' => Http::response(['run_id' => 2], 201)]);
        $base = $this->base();

        $res = $this->as(Role::Observer, 'Budi')->post("/runs/{$base->id}/fork", $this->body(['count' => 2]));

        $fork = SimRun::where('kind', 'simulation')->first();
        $res->assertRedirect(route('twin', ['run' => $fork->id]));
        $this->assertSame([$base->id, 420.0, 3, 'running'], [$fork->parent_run_id, $fork->fork_minute, $fork->seed, $fork->status]);
        $this->assertSame('D', $fork->config_snapshot['config']);

        $cmd = SimCommand::where('run_id', $fork->id)->sole();
        $this->assertSame(['ster_down', ['count' => 2, 'duration_min' => 240], 'Observer/Juri: Budi', 'Uji ketahanan jadwal'], [$cmd->kind, $cmd->args, $cmd->actor_label, $cmd->reason]);
        Http::assertSent(fn ($req) => $req['run_id'] === $fork->id && $req['seed'] === 3 && $req['config'] === 'D' && $req['volume_ton'] == 320
            && $req['commands'] === [['minute' => 420.0, 'kind' => 'ster_down', 'actor' => 'Observer/Juri: Budi', 'reason' => 'Uji ketahanan jadwal', 'count' => 2, 'duration_min' => 240]]);
    }

    public function test_tank_maintenance_sends_the_chosen_tank_and_rejects_unknown_ones(): void
    {
        Http::fake(['engine.test/*' => Http::response(['run_id' => 2], 201)]);
        $base = $this->base();
        $user = $this->as(Role::Observer, 'Budi');

        $user->post("/runs/{$base->id}/fork", $this->body(['kind' => 'tank_down', 'asset' => 'TK-STO-2']))->assertRedirect();
        $cmd = SimCommand::where('kind', 'tank_down')->sole();
        $this->assertSame(['asset' => 'TK-STO-2', 'duration_min' => 240], $cmd->args);
        Http::assertSent(fn ($req) => ($req['commands'][0]['asset'] ?? null) === 'TK-STO-2' && $req['commands'][0]['duration_min'] == 240);

        $user->post("/runs/{$base->id}/fork", $this->body(['kind' => 'tank_down', 'asset' => 'TK-RAW-99']))->assertSessionHasErrors('asset');
        $user->post("/runs/{$base->id}/fork", $this->body(['kind' => 'tank_down']))->assertSessionHasErrors('asset');
    }

    public function test_json_request_gets_the_url(): void
    {
        Http::fake(['engine.test/*' => Http::response([], 201)]);
        $base = $this->base();

        $res = $this->as(Role::Ppic)->postJson("/runs/{$base->id}/fork", $this->body(['kind' => 'cip_delay', 'factor' => 3]))->assertCreated();

        $this->assertSame(route('twin', ['run' => $res->json('run')]), $res->json('url'));
        $this->assertSame(['duration_min' => 120, 'factor' => 3], SimCommand::first()->args);
    }

    public function test_irrelevant_arguments_are_dropped_and_defaults_filled(): void
    {
        Http::fake(['engine.test/*' => Http::response([], 201)]);
        $base = $this->base();

        $this->as(Role::Admin)->post("/runs/{$base->id}/fork", $this->body(['kind' => 'truck_surge', 'factor' => 4, 'duration_min' => 60]));

        $this->assertSame(['count' => 4], SimCommand::first()->args);
    }

    public function test_only_allowed_roles_can_fork(): void
    {
        Http::fake(['engine.test/*' => Http::response([], 201)]);
        $base = $this->base();

        foreach ([Role::Qa, Role::Operator, Role::Driver] as $role) {
            $this->as($role)->post("/runs/{$base->id}/fork", $this->body())->assertForbidden();
        }
        $this->assertSame(0, SimRun::where('kind', 'simulation')->count());
        foreach ([Role::Ppic, Role::Admin, Role::Observer] as $role) {
            $this->as($role)->post("/runs/{$base->id}/fork", $this->body())->assertRedirect();
        }
        $this->assertSame(3, SimRun::where('kind', 'simulation')->count());
    }

    public function test_parent_must_be_finished(): void
    {
        Http::fake();
        $base = $this->base('running');

        $this->as(Role::Ppic)->postJson("/runs/{$base->id}/fork", $this->body())->assertStatus(422)->assertJsonValidationErrors('run');
        $this->assertSame(1, SimRun::count());
        Http::assertNothingSent();
    }

    public function test_input_is_validated(): void
    {
        Http::fake();
        $base = $this->base();
        $this->as(Role::Ppic);

        foreach ([['minute' => -1], ['minute' => 1440], ['kind' => 'meteor'], ['reason' => 'x'], ['reason' => ''], ['count' => 99], ['count' => 0], ['duration_min' => 5], ['factor' => 9]] as $bad) {
            $this->postJson("/runs/{$base->id}/fork", $this->body($bad))->assertStatus(422);
        }
        $this->assertSame(1, SimRun::count());
        Http::assertNothingSent();
    }

    public function test_engine_failure_marks_the_fork_failed(): void
    {
        Http::fake(['engine.test/*' => Http::response('x', 500)]);
        $base = $this->base();

        $this->as(Role::Ppic)->postJson("/runs/{$base->id}/fork", $this->body())->assertStatus(422)->assertJsonValidationErrors('engine');
        $this->assertSame('failed', SimRun::where('kind', 'simulation')->sole()->status);
    }

    public function test_chained_fork_copies_the_commands_of_its_parent(): void
    {
        Http::fake(['engine.test/*' => Http::response([], 201)]);
        $base = $this->base();
        $this->as(Role::Ppic, 'Dewi')->post("/runs/{$base->id}/fork", $this->body());
        $first = SimRun::where('kind', 'simulation')->sole();
        $first->update(['status' => 'finished']);

        $this->as(Role::Observer, 'Budi')->post("/runs/{$first->id}/fork", $this->body(['minute' => 600, 'kind' => 'truck_surge', 'reason' => 'Gelombang kedua']));

        $second = SimRun::where('parent_run_id', $first->id)->sole();
        $this->assertSame([1 => 'ster_down', 2 => 'truck_surge'], SimCommand::where('run_id', $second->id)->orderBy('seq')->pluck('kind', 'seq')->all());
        $this->assertSame(['PPIC: Dewi', 'Observer/Juri: Budi'], SimCommand::where('run_id', $second->id)->orderBy('seq')->pluck('actor_label')->all());
        $this->assertSame(600.0, $second->fork_minute);
        Http::assertSent(fn ($req) => $req['run_id'] === $second->id && count($req['commands']) === 2);
        $this->assertSame(1, SimCommand::where('run_id', $first->id)->count());
    }

    public function test_command_count_is_capped(): void
    {
        Http::fake(['engine.test/*' => Http::response([], 201)]);
        $base = $this->base();
        for ($i = 1; $i <= config('twin.commands.max'); $i++) {
            SimCommand::create(['run_id' => $base->id, 'seq' => $i, 'minute' => $i, 'kind' => 'truck_surge', 'args' => ['count' => 1], 'actor_label' => 'x', 'reason' => 'alasan']);
        }

        $this->as(Role::Ppic)->postJson("/runs/{$base->id}/fork", $this->body())->assertStatus(422)->assertJsonValidationErrors('kind');
    }

    public function test_simulations_are_not_the_default_run_and_not_in_comparison(): void
    {
        $this->withoutVite();
        $base = $this->base();
        $fork = SimRun::forceCreate([
            'kind' => 'simulation', 'seed' => 3, 'status' => 'finished', 'parent_run_id' => $base->id, 'fork_minute' => 420,
            'scenario_id' => $base->scenario_id, 'config_snapshot' => ['config' => 'A', 'scenario' => 'normal', 'params' => ['volume_ton' => 320, 'extra_bad' => 1]],
        ]);
        $this->as(Role::Ppic);

        $this->get('/twin')->assertOk()->assertSee(route('runs.replay', $base->id), false)->assertDontSee(route('runs.replay', $fork->id), false);
        $this->get("/runs/{$base->id}")->assertOk()->assertDontSee("runs/{$fork->id}", false);
    }

    public function test_replay_reports_fork_info_and_baseline_kpi(): void
    {
        $base = $this->base('finished', ['truck_wait_min' => ['mean' => 11, 'p90' => 22]]);
        $mid = SimRun::forceCreate(['kind' => 'simulation', 'seed' => 3, 'status' => 'finished', 'parent_run_id' => $base->id, 'fork_minute' => 100, 'config_snapshot' => []]);
        $leaf = SimRun::forceCreate(['kind' => 'simulation', 'seed' => 3, 'status' => 'running', 'parent_run_id' => $mid->id, 'fork_minute' => 420, 'config_snapshot' => []]);
        $this->as(Role::Observer);

        $res = $this->getJson("/runs/{$leaf->id}/replay")->assertOk();
        $this->assertSame(['simulation', 420, $mid->id, false], [$res->json('run.kind'), $res->json('run.fork_minute'), $res->json('run.parent_id'), $res->json('run.badge') !== null]);
        $this->assertSame([$base->id, 11], [$res->json('baseline.id'), $res->json('baseline.kpi.truck_wait_min.mean')]);

        $plain = $this->getJson("/runs/{$base->id}/replay")->assertOk();
        $this->assertNull($plain->json('baseline'));
        $this->assertNull($plain->json('run.badge'));
    }

    public function test_twin_page_shows_badge_and_simulation_panel_per_role(): void
    {
        $this->withoutVite();
        $base = $this->base();
        $fork = SimRun::forceCreate(['kind' => 'simulation', 'seed' => 3, 'status' => 'finished', 'parent_run_id' => $base->id, 'fork_minute' => 420, 'config_snapshot' => []]);

        $this->as(Role::Ppic)->get("/runs/{$base->id}/twin")->assertOk()->assertSee('Pratinjau dampak')
            ->assertSee('id="mode-sim"', false)->assertSee('id="sim-form"', false)->assertSee('id="iv-form"', false)->assertSee('id="sim-score"', false)->assertSee(route('runs.fork', $base), false);
        $this->get("/runs/{$fork->id}/twin")->assertOk()->assertSee('data-simulation="1"', false);
        $this->as(Role::Observer)->get("/runs/{$base->id}/twin")->assertOk()->assertSee('id="sim-form"', false)->assertDontSee('id="iv-form"', false);

        $this->as(Role::Qa)->get("/runs/{$base->id}/twin")->assertOk()->assertDontSee('id="mode-sim"', false)->assertDontSee('id="sim-form"', false)->assertDontSee('id="iv-form"', false);
        $this->get("/runs/{$fork->id}/twin")->assertOk()->assertSee('id="mode-sim"', false)->assertSee('id="sim-log"', false)->assertDontSee('id="sim-form"', false)->assertDontSee('id="iv-form"', false);
    }

    public function test_run_list_marks_simulations(): void
    {
        $this->withoutVite();
        $base = $this->base();
        SimRun::forceCreate(['kind' => 'simulation', 'seed' => 3, 'status' => 'finished', 'parent_run_id' => $base->id, 'fork_minute' => 420, 'config_snapshot' => []]);

        $this->as(Role::Ppic)->get('/runs')->assertOk()->assertSee("Pratinjau dari #{$base->id}");
    }

    public function test_intervention_fork_stores_truck_args_and_sends_them_to_engine(): void
    {
        Http::fake(['engine.test/*' => Http::response([], 201)]);
        $base = $this->base();
        $this->as(Role::Ppic, 'Dewi');

        $cases = [
            ['plan_approve', ['truck' => 'RT-002'], ['truck' => 'RT-002']],
            ['plan_reject', ['truck' => 'RT-002', 'bay' => 'BAY-2'], ['truck' => 'RT-002']],
            ['plan_change', ['truck' => 'RT-002', 'bay' => 'BAY-2', 'start_min' => '500.04'], ['truck' => 'RT-002', 'bay' => 'BAY-2', 'start_min' => 500.0]],
            ['plan_change', ['truck' => 'RT-002', 'start_min' => 480], ['truck' => 'RT-002', 'start_min' => 480.0]],
            ['truck_hold', ['truck' => 'RT-004'], ['truck' => 'RT-004', 'duration_min' => 60]],
            ['truck_hold', ['truck' => 'RT-004', 'duration_min' => 45], ['truck' => 'RT-004', 'duration_min' => 45]],
            ['truck_release', ['truck' => 'RT-008', 'duration_min' => 45], ['truck' => 'RT-008']],
        ];
        foreach ($cases as [$kind, $input, $expected]) {
            SimRun::where('kind', 'simulation')->delete();
            SimCommand::query()->delete();
            $this->post("/runs/{$base->id}/fork", $this->body(['kind' => $kind] + $input))->assertRedirect();
            $this->assertEquals($expected, SimCommand::sole()->args, $kind);
        }
        Http::assertSent(fn ($req) => ($req['commands'][0]['kind'] ?? null) === 'truck_release' && $req['commands'][0]['truck'] === 'RT-008' && $req['commands'][0]['actor'] === 'PPIC: Dewi');
    }

    public function test_interventions_need_the_intervene_ability(): void
    {
        Http::fake(['engine.test/*' => Http::response([], 201)]);
        $base = $this->base();

        $this->as(Role::Observer);
        foreach (array_keys(config('twin.commands.interventions')) as $kind) {
            $this->postJson("/runs/{$base->id}/fork", $this->body(['kind' => $kind, 'truck' => 'RT-002', 'bay' => 'BAY-1']))->assertForbidden();
        }
        $this->assertSame(0, SimRun::where('kind', 'simulation')->count());
        $this->postJson("/runs/{$base->id}/fork", $this->body())->assertCreated(); // gangguan tetap boleh
        $this->as(Role::Admin)->postJson("/runs/{$base->id}/fork", $this->body(['kind' => 'plan_approve', 'truck' => 'RT-002']))->assertCreated();
    }

    public function test_intervention_input_is_validated(): void
    {
        Http::fake();
        $base = $this->base();
        $this->as(Role::Ppic);

        $bad = [
            ['kind' => 'plan_approve'],
            ['kind' => 'plan_approve', 'truck' => 'rt-2'],
            ['kind' => 'plan_approve', 'truck' => 'RT-002; drop'],
            ['kind' => 'plan_change', 'truck' => 'RT-002'],
            ['kind' => 'plan_change', 'truck' => 'RT-002', 'bay' => 'BAY-999'],
            ['kind' => 'plan_change', 'truck' => 'RT-002', 'start_min' => 2880],
            ['kind' => 'plan_change', 'truck' => 'RT-002', 'start_min' => -1],
            ['kind' => 'truck_hold', 'truck' => 'RT-002', 'duration_min' => 5],
        ];
        foreach ($bad as $over) {
            $this->postJson("/runs/{$base->id}/fork", $this->body($over))->assertStatus(422);
        }
        $this->assertSame(1, SimRun::count());
        Http::assertNothingSent();
    }

    public function test_replay_lists_plan_versions_with_replan_times(): void
    {
        $base = $this->base();
        $sid = DB::table('schedules')->insertGetId(['run_id' => $base->id, 'name' => 't', 'created_at' => now(), 'updated_at' => now()]);
        $row = fn (int $v, array $trucks) => ['schedule_id' => $sid, 'version' => $v, 'status' => 'proposed', 'config' => 'D', 'created_by' => 'optimizer',
            'plan' => json_encode(['trucks' => $trucks]), 'created_at' => now(), 'updated_at' => now()];
        DB::table('schedule_versions')->insert([$row(1, [['code' => 'RT-001', 'bay' => 'BAY-1']]), $row(2, [['code' => 'RT-002', 'bay' => 'BAY-2']])]);
        DB::table('sim_events')->insert(['run_id' => $base->id, 'seq' => 1, 'sim_time' => '2026-10-28 08:00:00+00', 'type' => 'schedule.replanned',
            'payload' => json_encode(['type' => 'schedule.replanned', 'version' => 2])]);
        $this->as(Role::Ppic);

        $plans = $this->getJson("/runs/{$base->id}/replay")->assertOk()->json('plans');

        $this->assertSame([1, null, 'RT-001'], [$plans[0]['version'], $plans[0]['at'], $plans[0]['trucks'][0]['code']]);
        $this->assertSame([2, '2026-10-28T08:00:00Z', 'BAY-2'], [$plans[1]['version'], $plans[1]['at'], $plans[1]['trucks'][0]['bay']]);
    }

    public function test_mode_badge_per_status(): void
    {
        $badge = fn (string $kind, string $status) => (new SimRun(['kind' => $kind, 'status' => $status]))->modeBadge()['key'];

        $this->assertSame('live', $badge('live', 'running'));
        $this->assertSame('live', $badge('live', 'pending'));
        $this->assertSame('sample', $badge('live', 'finished'));
        $this->assertSame('sim', $badge('simulation', 'finished'));
    }
}
