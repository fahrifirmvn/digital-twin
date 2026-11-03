<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\AgentAction;
use App\Models\AgentMandate;
use App\Models\SimCommand;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

// Agen Copilot (P6): mandat, tindakan sebagai cabang kandidat, verifikasi, veto, dan batas yang tidak bisa dilewati.
class AgentTest extends TestCase
{
    use RefreshDatabase;

    private const START = '2026-03-02T06:00:00Z';

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
        Http::fake(['engine.test/*' => Http::response(['run_id' => 2], 201)]);
    }

    private function ppic(): User
    {
        return User::factory()->role(Role::Ppic)->create(['name' => 'Dewi']);
    }

    private function mandate(User $by, int $level, int $max = 6): void
    {
        AgentMandate::create(['level' => $level, 'max_actions' => $max, 'reason' => 'Uji tingkat otomasi', 'set_by' => $by->id]);
    }

    private function at(int $minute): string
    {
        return date('Y-m-d H:i:s', strtotime(self::START) + $minute * 60);
    }

    private function event(int $run, int $seq, int $minute, string $type, array $payload): void
    {
        DB::table('sim_events')->insert(['run_id' => $run, 'seq' => $seq, 'sim_time' => $this->at($minute), 'type' => $type, 'payload' => json_encode($payload + ['type' => $type])]);
    }

    private function kpi(float $mean): int
    {
        return DB::table('scenarios')->insertGetId(['name' => 't', 'params' => '{}', 'seed' => 3, 'kpi_result' => json_encode(['truck_wait_min' => ['mean' => $mean]]), 'created_at' => now(), 'updated_at' => now()]);
    }

    /** Run dasar selesai: TK-001 antre lab, TK-002 antre bay, TK-003 sedang bongkar, TK-009 menuju gerbang. */
    private function base(): SimRun
    {
        $run = SimRun::forceCreate([
            'kind' => 'live', 'seed' => 3, 'status' => 'finished', 'scenario_id' => $this->kpi(20), 'sim_start' => self::START,
            'config_snapshot' => ['config' => 'B', 'scenario' => 'normal', 'params' => []],
        ]);
        $this->event($run->id, 1, 0, 'sim.clock', ['speed' => 0, 'paused' => false]);
        $this->event($run->id, 2, 430, 'tanker.status_changed', ['tanker_code' => 'TK-001', 'status' => 'sampling']);
        $this->event($run->id, 3, 440, 'tanker.status_changed', ['tanker_code' => 'TK-002', 'status' => 'released']);
        $this->event($run->id, 4, 400, 'tanker.status_changed', ['tanker_code' => 'TK-003', 'status' => 'unloading']);
        $this->event($run->id, 5, 420, 'truck.dispatched', ['tanker_code' => 'TK-009', 'eta' => date('Y-m-d\TH:i:s\Z', strtotime(self::START) + 600 * 60)]);
        $scheduleId = DB::table('schedules')->insertGetId(['run_id' => $run->id, 'name' => 'S', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('schedule_versions')->insert([
            'schedule_id' => $scheduleId, 'version' => 1, 'status' => 'active', 'config' => 'B', 'created_by' => 'engine',
            'plan' => json_encode(['trucks' => [['code' => 'TK-001'], ['code' => 'TK-002'], ['code' => 'TK-003']]]), 'created_at' => now(), 'updated_at' => now(),
        ]);

        return $run;
    }

    private function finishFork(AgentAction $a, float $mean, array $commandEvents = []): void
    {
        DB::table('sim_runs')->where('id', $a->fork_run_id)->update(['status' => 'finished', 'scenario_id' => $this->kpi($mean)]);
        foreach ($commandEvents as $i => $p) {
            $this->event($a->fork_run_id, $i + 1, 450, 'command.applied', $p + ['command_id' => $i + 1]);
        }
    }

    private function propose(User $user, SimRun $base, int $minute = 450): AgentAction
    {
        $this->actingAs($user)->postJson("/runs/{$base->id}/agent", ['minute' => $minute])->assertCreated();

        return AgentAction::latest('id')->first();
    }

    public function test_only_ppic_sets_the_mandate_and_it_needs_a_reason(): void
    {
        $body = ['level' => 2, 'max_actions' => 4, 'reason' => 'Shift siang tenang'];
        foreach ([Role::Admin, Role::Observer, Role::Qa] as $role) {
            $this->actingAs(User::factory()->role($role)->create())->postJson('/agent/mandate', $body)->assertForbidden();
        }
        $ppic = $this->ppic();
        $this->actingAs($ppic)->postJson('/agent/mandate', ['reason' => 'x'] + $body)->assertUnprocessable();
        $this->actingAs($ppic)->postJson('/agent/mandate', ['level' => 4] + $body)->assertUnprocessable();
        $this->actingAs($ppic)->postJson('/agent/mandate', $body)->assertCreated();

        $this->assertSame([2, 4, $ppic->id], [AgentMandate::currentLevel(), (int) AgentMandate::current()->max_actions, AgentMandate::current()->set_by]);
    }

    public function test_default_level_is_zero_and_agent_refuses_to_act(): void
    {
        $base = $this->base();
        $this->assertSame(0, AgentMandate::currentLevel());
        $this->actingAs($this->ppic())->postJson("/runs/{$base->id}/agent", ['minute' => 450])->assertUnprocessable()->assertJsonValidationErrors('agent');
        $this->assertSame(0, AgentAction::count());
    }

    public function test_only_intervene_roles_can_trigger_decide_but_observers_can_read(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 1);
        $observer = User::factory()->role(Role::Observer)->create();
        $this->actingAs($observer)->postJson("/runs/{$base->id}/agent", ['minute' => 450])->assertForbidden();
        $this->actingAs($observer)->getJson("/runs/{$base->id}/agent")->assertOk()->assertJsonPath('can.act', false)->assertJsonPath('mandate.level', 1);
    }

    public function test_propose_creates_candidate_fork_with_plan_approvals_by_agent_actor(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 1);

        $a = $this->propose($ppic, $base);

        $this->assertSame(['verifying', 1, 450.0], [$a->status, $a->level, $a->minute]);
        $fork = SimRun::findOrFail($a->fork_run_id);
        $this->assertSame([$base->id, 'simulation'], [$fork->parent_run_id, $fork->kind]);
        $cmds = SimCommand::where('run_id', $fork->id)->orderBy('seq')->get();
        $this->assertSame(['plan_approve', 'plan_approve'], $cmds->pluck('kind')->all());
        $this->assertSame(['TK-001', 'TK-002'], $cmds->map(fn ($c) => $c->args['truck'])->all());
        $this->assertSame(['agent:copilot'], $cmds->pluck('actor_label')->unique()->values()->all());
        $this->assertNull($cmds[0]->actor_id);
        Http::assertSent(fn ($r) => str_contains($r->url(), 'engine.test') && ($r['commands'][0]['actor'] ?? '') === 'agent:copilot');
    }

    public function test_nothing_to_handle_returns_error_without_fork(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 1);
        $this->actingAs($ppic)->postJson("/runs/{$base->id}/agent", ['minute' => 100])->assertUnprocessable()->assertJsonValidationErrors('agent');
        $this->assertSame(0, SimRun::where('kind', 'simulation')->count());
    }

    public function test_level_one_waits_for_ppic_approval_after_verification(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 1);
        $a = $this->propose($ppic, $base);

        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")->assertJsonPath('actions.0.status', 'verifying');
        $this->finishFork($a, 18.4);
        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")
            ->assertJsonPath('actions.0.status', 'awaiting')->assertJsonPath('actions.0.verdict.delta', -1.6)->assertJsonPath('actions.0.approve', ['TK-001', 'TK-002']);

        $this->actingAs($ppic)->postJson("/agent/actions/{$a->id}/approve", ['reason' => 'x'])->assertUnprocessable();
        $this->actingAs($ppic)->postJson("/agent/actions/{$a->id}/approve", ['reason' => 'Sesuai kapasitas lab'])->assertOk()->assertJsonPath('status', 'applied');
        $this->assertSame(['applied', 'Dewi'], [AgentAction::find($a->id)->status, explode(': ', AgentAction::find($a->id)->decided_by)[1]]);
    }

    public function test_level_two_applies_automatically_with_a_veto_window_then_only_undo(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 2);
        $a = $this->propose($ppic, $base);
        $this->finishFork($a, 19);

        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")
            ->assertJsonPath('actions.0.status', 'applied')->assertJsonPath('actions.0.decided_by', 'agent:copilot')->assertJsonPath('actions.0.can_veto', true);
        $this->assertGreaterThan(0, $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")->json('actions.0.veto_left'));

        // Jendela veto lewat: veto ditolak, Batalkan tetap bisa.
        $this->travel(11)->minutes();
        $this->actingAs($ppic)->postJson("/agent/actions/{$a->id}/veto", ['reason' => 'Terlambat veto'])->assertUnprocessable()->assertJsonValidationErrors('action');
        $this->assertSame('applied', AgentAction::find($a->id)->status);
        $this->actingAs($ppic)->postJson("/agent/actions/{$a->id}/undo", ['reason' => 'Bay 2 dipakai maintenance'])->assertOk()->assertJsonPath('status', 'undone');
        $this->actingAs($ppic)->postJson("/agent/actions/{$a->id}/undo", ['reason' => 'Bay 2 dipakai maintenance'])->assertUnprocessable();
    }

    public function test_veto_inside_the_window_cancels_the_auto_applied_action(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 3);
        $a = $this->propose($ppic, $base);
        $this->finishFork($a, 20);

        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")->assertJsonPath('actions.0.status', 'applied');
        $this->actingAs($ppic)->postJson("/agent/actions/{$a->id}/veto", ['reason' => 'Saya ingin cek manual'])->assertOk()->assertJsonPath('status', 'vetoed');
        $this->assertSame('vetoed', AgentAction::find($a->id)->status);
    }

    public function test_lowering_the_mandate_before_verification_downgrades_auto_apply_to_approval(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 2);
        $a = $this->propose($ppic, $base);
        $this->mandate($ppic, 1);
        $this->finishFork($a, 15);

        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")->assertJsonPath('actions.0.status', 'awaiting');
    }

    public function test_slower_candidate_is_rejected_and_never_applied(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 3);
        $a = $this->propose($ppic, $base);
        $this->finishFork($a, 25);

        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")->assertJsonPath('actions.0.status', 'rejected')->assertJsonPath('actions.0.verdict.verdict', 'belum');
        $this->actingAs($ppic)->postJson("/agent/actions/{$a->id}/approve", ['reason' => 'Tetap setujui'])->assertUnprocessable();
    }

    public function test_gate_violation_in_candidate_is_rejected_even_if_faster(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 3);
        $a = $this->propose($ppic, $base);
        $this->finishFork($a, 5, [['kind' => 'truck_release', 'blocked' => true, 'gate' => 'G1', 'truck' => 'TK-001']]);

        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")->assertJsonPath('actions.0.status', 'rejected')->assertJsonPath('actions.0.verdict.verdict', 'gagal')->assertJsonPath('actions.0.verdict.violations', 1);
    }

    public function test_failed_candidate_run_is_rejected(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 2);
        $a = $this->propose($ppic, $base);
        DB::table('sim_runs')->where('id', $a->fork_run_id)->update(['status' => 'failed', 'error' => 'solver']);

        $this->actingAs($ppic)->getJson("/runs/{$base->id}/agent")->assertJsonPath('actions.0.status', 'rejected');
    }

    public function test_level_three_holds_inbound_trucks_arriving_during_a_sterilizer_outage_only_at_level_three(): void
    {
        $base = $this->base();
        SimCommand::create(['run_id' => $base->id, 'seq' => 1, 'minute' => 480, 'kind' => 'ster_down', 'args' => ['count' => 1, 'duration_min' => 240], 'actor_label' => 'PPIC: Dewi', 'reason' => 'Uji gangguan']);
        $ppic = $this->ppic();

        $this->mandate($ppic, 2);
        $this->assertSame(['plan_approve', 'plan_approve'], array_column($this->propose($ppic, $base)->commands, 'kind'));

        $this->mandate($ppic, 3);
        $this->assertSame(['plan_approve', 'plan_approve', 'truck_hold'], array_column($this->propose($ppic, $base)->commands, 'kind'));
    }

    public function test_agent_actions_per_run_are_capped(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 1);
        config(['twin.agent.max_per_run' => 2]);
        $this->propose($ppic, $base);
        $this->propose($ppic, $base);
        $this->actingAs($ppic)->postJson("/runs/{$base->id}/agent", ['minute' => 450])->assertUnprocessable()->assertJsonValidationErrors('agent');
    }

    public function test_agent_commands_never_include_gate_or_release_kinds(): void
    {
        $base = $this->base();
        $ppic = $this->ppic();
        $this->mandate($ppic, 3);
        $this->propose($ppic, $base);

        $kinds = SimCommand::where('actor_label', 'agent:copilot')->pluck('kind')->unique()->all();
        $this->assertEmpty(array_diff($kinds, ['plan_approve', 'truck_hold']));
    }
}
