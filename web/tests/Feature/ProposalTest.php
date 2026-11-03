<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\AgentProposal;
use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\SimRun;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\CampaignService;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use LogicException;
use Tests\TestCase;

// Usulan Operator Agent: draf dari engine, validasi ulang aturan keras, persetujuan PPIC dengan alasan.
class ProposalTest extends TestCase
{
    use RefreshDatabase;

    /** @var list<array{0:string,1:array<string,mixed>}> */
    private array $audit = [];

    /** @var array<string, mixed> */
    private array $reply = [];

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);
        Http::fake(['engine.test/*' => fn () => Http::response($this->reply)]);
        $this->mock(AuditLogger::class, function ($m) {
            $m->shouldReceive('record')->andReturnUsing(function ($type, $id, $action, $payload = []) {
                $this->audit[] = [$action, $payload];
            });
        });
    }

    private function as(Role $role): User
    {
        return tap(User::factory()->role($role)->create(['name' => 'Dewi']), fn ($u) => $this->actingAs($u));
    }

    private function campaign(array $params = []): Campaign
    {
        return app(CampaignService::class)->create(User::factory()->role(Role::Ppic)->create(), [
            'name' => 'Uji', 'seed' => 10, 'start_date' => '2026-03-01', 'config' => 'A', 'scenario' => 'normal',
            'params' => $params + ['volume_ton' => 320, 'extra_bad' => 0], 'speed' => null,
        ])->refresh();
    }

    private function draft(array $payload = ['asset' => 'TK-RAW-1', 'minute' => 120, 'duration_min' => 180], array $over = []): array
    {
        return $over + [
            'id' => (string) Str::uuid(), 'kind' => 'tank_maintenance', 'campaign_id' => 999, 'day_no' => 999, 'payload' => $payload,
            'rationale' => 'Beban rendah pada jam itu.', 'supersedes' => null,
            'evidence' => ['whatif_id' => 'wi-abcdef012345', 'result_hash' => str_repeat('b', 64), 'config_requested' => 'A', 'config_used' => 'A',
                'baseline' => ['trucks' => 27], 'candidate' => ['trucks' => 27], 'changes' => ['truck_wait_mean_min' => ['baseline' => 10.0, 'candidate' => 12.5, 'change' => 2.5, 'better' => false]], 'findings' => []],
        ];
    }

    private function engineReply(array $drafts, array $over = []): array
    {
        $audit = array_map(fn ($d) => [
            'conversation_id' => 'x', 'user_id' => 1, 'role' => 'ppic', 'mode' => 'SIMULASI', 'model_name' => 'gemini', 'model_version' => 'g-1',
            'tool' => 'create_proposal', 'args' => [], 'result_hash' => str_repeat('a', 64), 'ok' => true, 'error' => null, 'step' => 1, 'ms' => 3,
            'at' => '2026-03-01T10:00:00+00:00', 'proposal_id' => $d['id'],
        ], $drafts);

        return $over + ['status' => 'ok', 'text' => 'Draf dibuat.', 'mode' => 'SIMULASI', 'label' => 'DATA SINTETIS | mode SIMULASI', 'error' => null,
            'sources' => [], 'provider' => 'gemini', 'model' => 'gemini-2.5-flash', 'model_version' => 'g-1', 'audit' => $audit, 'proposals' => $drafts];
    }

    private function turn(Campaign $c, array $drafts)
    {
        $this->reply = $this->engineReply($drafts);

        return $this->postJson('/agent/turn', ['message' => 'Jadwalkan maintenance', 'campaign_id' => $c->id]);
    }

    /** Usulan pending siap diputuskan. */
    private function pending(Campaign $c, ?array $payload = null): AgentProposal
    {
        $this->as(Role::Operator);
        $d = $payload ? $this->draft($payload) : $this->draft();
        $this->turn($c, [$d])->assertOk();
        $p = AgentProposal::where('uuid', $d['id'])->firstOrFail();
        $this->postJson("/agent/proposals/{$p->uuid}/submit")->assertOk();

        return $p->refresh();
    }

    public function test_turn_sends_campaign_state_from_database_and_forces_simulasi(): void
    {
        $c = $this->campaign();
        $live = SimRun::forceCreate(['kind' => 'live', 'seed' => 1, 'status' => 'running']);
        $this->as(Role::Ppic);
        $this->reply = $this->engineReply([]);

        $this->postJson('/agent/turn', ['message' => 'x', 'campaign_id' => $c->id, 'run_id' => $live->id, 'role' => 'admin'])->assertOk();

        Http::assertSent(function ($r) use ($c) {
            $ctx = $r['campaign'];

            return $r['mode'] === 'SIMULASI' && $r['run_id'] === null && $ctx['campaign_id'] === $c->id && $ctx['day_no'] === 1
                && $ctx['editable'] === true && $ctx['config'] === 'A' && $ctx['seed'] === $c->daySeed(1) && $ctx['existing'] === []
                && $ctx['planned_count'] === 0 && $ctx['max_planned'] === 10;
        });
    }

    public function test_agent_draft_is_stored_as_draft_with_evidence_and_audit_link(): void
    {
        $c = $this->campaign();
        $user = $this->as(Role::Operator);
        $d = $this->draft();

        $res = $this->turn($c, [$d])->assertOk();

        $p = AgentProposal::firstOrFail();
        $this->assertSame([$d['id'], 'draft', 1, 1, 'SIMULASI', $user->id], [$p->uuid, $p->status, $p->day_no, $p->version, $p->mode, $p->created_by]);
        $this->assertSame($d['payload'], $p->payload);
        $this->assertSame(hash('sha256', json_encode($d['evidence'])), $p->evidence_hash);
        $this->assertSame('g-1', $p->model_version);
        $res->assertJsonPath('proposals.0.id', $d['id'])->assertJsonPath('proposals.0.status', 'draft')->assertJsonPath('proposals.0.label', 'DATA SINTETIS | mode SIMULASI');
        $this->assertSame([$d['id']], array_values(array_map(fn ($a) => $a[1]['proposal_id'], array_filter($this->audit, fn ($a) => $a[0] === 'agent.tool_call'))));
        $this->assertContains('agent.proposal_created', array_column($this->audit, 0));
        $this->assertSame([], $c->days()->first()->plan);
    }

    public function test_draft_that_breaks_hard_rules_is_discarded_even_if_engine_allowed_it(): void
    {
        $c = $this->campaign(['plant' => ['n_raw_tanks' => 1]]);
        $this->as(Role::Ppic);
        $bad = [
            $this->draft(['asset' => 'TK-RAW-1', 'minute' => 10, 'duration_min' => 60]),   // satu-satunya tangki RAW
            $this->draft(['asset' => 'TK-RAW-9', 'minute' => 10, 'duration_min' => 60]),   // tangki tidak ada
            $this->draft(['asset' => 'TK-STO-1', 'minute' => 10, 'duration_min' => 5]),    // durasi di luar batas
            $this->draft(['asset' => "TK-STO-1'; DROP", 'minute' => 10, 'duration_min' => 60]),
        ];

        $res = $this->turn($c, $bad)->assertOk();

        $this->assertSame(0, AgentProposal::count());
        $res->assertJsonPath('proposals', []);
        $this->assertSame([null, null, null, null], array_map(fn ($a) => $a[1]['proposal_id'], array_values(array_filter($this->audit, fn ($a) => $a[0] === 'agent.tool_call'))));
        $this->assertSame(4, count(array_filter($this->audit, fn ($a) => $a[0] === 'agent.proposal_discarded')));
    }

    public function test_draft_is_not_stored_when_day_is_not_editable_or_turn_not_ok(): void
    {
        $c = $this->campaign();
        $this->as(Role::Ppic);
        $c->days()->first()->update(['status' => 'running']);
        $this->turn($c, [$this->draft()])->assertOk();
        $c->days()->first()->update(['status' => 'planned']);
        $this->reply = $this->engineReply([$this->draft()], ['status' => 'rejected']);
        $this->postJson('/agent/turn', ['message' => 'x', 'campaign_id' => $c->id])->assertOk();

        $this->assertSame(0, AgentProposal::count());
    }

    public function test_revision_supersedes_the_previous_version_of_the_same_user(): void
    {
        $c = $this->campaign();
        $this->as(Role::Operator);
        $first = $this->draft();
        $this->turn($c, [$first]);
        $second = $this->draft(['asset' => 'TK-RAW-1', 'minute' => 300, 'duration_min' => 120], ['supersedes' => $first['id']]);
        $this->turn($c, [$second]);

        $old = AgentProposal::where('uuid', $first['id'])->first();
        $new = AgentProposal::where('uuid', $second['id'])->first();
        $this->assertSame(['superseded', 2, $first['id']], [$old->status, $new->version, $new->supersedes_uuid]);
        $this->assertSame(120, $old->payload['minute'] + 0);

        // pengguna lain tidak dapat menggantikan usulan orang lain
        $this->as(Role::Qa);
        $third = $this->draft(['asset' => 'TK-STO-1', 'minute' => 0, 'duration_min' => 60], ['supersedes' => $second['id']]);
        $this->turn($c, [$third]);
        $this->assertSame('draft', $new->refresh()->status);
        $this->assertNull(AgentProposal::where('uuid', $third['id'])->first()->supersedes_uuid);
    }

    public function test_submit_only_by_creator_or_approver_and_only_from_draft(): void
    {
        $c = $this->campaign();
        $this->as(Role::Operator);
        $d = $this->draft();
        $this->turn($c, [$d]);

        $this->as(Role::Qa);
        $this->postJson("/agent/proposals/{$d['id']}/submit")->assertForbidden();
        $this->as(Role::Driver);
        $this->postJson("/agent/proposals/{$d['id']}/submit")->assertForbidden();
        $this->as(Role::Ppic);
        $this->postJson("/agent/proposals/{$d['id']}/submit")->assertOk()->assertJsonPath('proposal.status', 'pending');
        $this->postJson("/agent/proposals/{$d['id']}/submit")->assertStatus(422);
        $this->assertContains('agent.proposal_submitted', array_column($this->audit, 0));
    }

    public function test_only_ppic_and_admin_decide_and_a_reason_is_mandatory(): void
    {
        $p = $this->pending($this->campaign());

        foreach ([Role::Qa, Role::Operator, Role::Observer, Role::Driver] as $role) {
            $this->as($role);
            $this->postJson("/agent/proposals/{$p->uuid}/approve", ['reason' => 'Setuju sekali'])->assertForbidden();
            $this->postJson("/agent/proposals/{$p->uuid}/reject", ['reason' => 'Tidak setuju'])->assertForbidden();
        }
        $this->as(Role::Ppic);
        $this->postJson("/agent/proposals/{$p->uuid}/approve")->assertStatus(422);
        $this->postJson("/agent/proposals/{$p->uuid}/approve", ['reason' => 'ok'])->assertStatus(422);
        $this->postJson("/agent/proposals/{$p->uuid}/reject", ['reason' => '    '])->assertStatus(422);
        $this->assertSame('pending', $p->refresh()->status);
        $this->assertSame([], $p->campaign->days()->first()->plan);
    }

    public function test_approval_applies_a_regular_maintenance_entry_and_is_final(): void
    {
        $c = $this->campaign();
        $p = $this->pending($c);
        $ppic = $this->as(Role::Ppic);

        $this->postJson("/agent/proposals/{$p->uuid}/approve", ['reason' => 'Beban rendah, aman dijadwalkan'])->assertOk()
            ->assertJsonPath('proposal.status', 'approved')->assertJsonPath('proposal.decided_by', $ppic->id);

        $plan = $c->days()->first()->plan;
        $this->assertCount(1, $plan);
        $this->assertSame(['tank_down', 'TK-RAW-1', 120.0, 180.0, $ppic->id], [$plan[0]['kind'], $plan[0]['asset'], (float) $plan[0]['minute'], (float) $plan[0]['duration_min'], $plan[0]['actor_id']]);
        $this->assertStringContainsString($p->uuid, $plan[0]['reason']);
        $this->assertStringContainsString('Beban rendah, aman dijadwalkan', $plan[0]['reason']);
        $row = collect($this->audit)->firstWhere(0, 'agent.proposal_approved')[1];
        $this->assertSame([$p->uuid, 'Beban rendah, aman dijadwalkan', $p->evidence_hash], [$row['proposal_id'], $row['reason'], $row['evidence_hash']]);

        $this->postJson("/agent/proposals/{$p->uuid}/approve", ['reason' => 'Sekali lagi'])->assertStatus(422);
        $this->postJson("/agent/proposals/{$p->uuid}/reject", ['reason' => 'Sekali lagi'])->assertStatus(422);
        $this->assertCount(1, $c->days()->first()->plan);
    }

    public function test_draft_cannot_be_approved_without_being_submitted(): void
    {
        $c = $this->campaign();
        $this->as(Role::Operator);
        $d = $this->draft();
        $this->turn($c, [$d]);
        $this->as(Role::Ppic);

        $this->postJson("/agent/proposals/{$d['id']}/approve", ['reason' => 'Langsung setuju'])->assertStatus(422);
        $this->assertSame([], $c->days()->first()->plan);
    }

    public function test_reject_records_reason_and_applies_nothing(): void
    {
        $c = $this->campaign();
        $p = $this->pending($c);
        $this->as(Role::Admin);

        $this->postJson("/agent/proposals/{$p->uuid}/reject", ['reason' => 'Lini sedang penuh'])->assertOk()->assertJsonPath('proposal.status', 'rejected')
            ->assertJsonPath('proposal.decision_reason', 'Lini sedang penuh');
        $this->assertSame([], $c->days()->first()->plan);
        $this->assertContains('agent.proposal_rejected', array_column($this->audit, 0));
    }

    public function test_approval_rechecks_hard_rules_and_expires_stale_proposal(): void
    {
        $c = $this->campaign();
        $p = $this->pending($c);
        $ppic = $this->as(Role::Ppic);
        // sementara itu tangki yang sama dijadwalkan manual
        app(CampaignService::class)->planMaintenance($c, $ppic, 'TK-RAW-1', 600, 60, 'Servis manual');

        $this->postJson("/agent/proposals/{$p->uuid}/approve", ['reason' => 'Setuju saja'])->assertStatus(422)
            ->assertJsonPath('errors.proposal.0', fn ($m) => str_contains($m, 'kedaluwarsa'));

        $this->assertSame('expired', $p->refresh()->status);
        $this->assertCount(1, $c->days()->first()->plan);
        $this->assertContains('agent.proposal_expired', array_column($this->audit, 0));
    }

    public function test_proposal_expires_when_the_day_changes_or_is_no_longer_editable(): void
    {
        $c = $this->campaign();
        $p = $this->pending($c);
        CampaignDay::create(['campaign_id' => $c->id, 'day_no' => 2, 'carry_in' => [], 'plan' => []]);
        $c->update(['current_day' => 2]);
        $this->as(Role::Ppic);

        $this->postJson("/agent/proposals/{$p->uuid}/approve", ['reason' => 'Terlambat'])->assertStatus(422);
        $this->assertSame('expired', $p->refresh()->status);

        $c2 = $this->campaign();
        $q = $this->pending($c2);
        $c2->days()->first()->update(['status' => 'running']);
        $this->as(Role::Ppic);
        $this->postJson("/agent/proposals/{$q->uuid}/approve", ['reason' => 'Hari sudah jalan'])->assertStatus(422);
        $this->assertSame('expired', $q->refresh()->status);
    }

    public function test_last_tank_of_a_kind_cannot_be_taken_down_by_two_approved_proposals(): void
    {
        $c = $this->campaign(['plant' => ['n_raw_tanks' => 2]]);
        $a = $this->pending($c, ['asset' => 'TK-RAW-1', 'minute' => 100, 'duration_min' => 300]);
        $this->as(Role::Operator);
        $b = $this->draft(['asset' => 'TK-RAW-2', 'minute' => 200, 'duration_min' => 100]);
        $this->turn($c, [$b]);
        $this->postJson("/agent/proposals/{$b['id']}/submit")->assertOk();
        $this->as(Role::Ppic);

        $this->postJson("/agent/proposals/{$a->uuid}/approve", ['reason' => 'Servis pertama'])->assertOk();
        $this->postJson("/agent/proposals/{$b['id']}/approve", ['reason' => 'Servis kedua'])->assertStatus(422);

        $this->assertSame('expired', AgentProposal::where('uuid', $b['id'])->value('status'));
        $this->assertCount(1, $c->days()->first()->plan);
    }

    public function test_live_proposals_are_never_applied(): void
    {
        $c = $this->campaign();
        $this->as(Role::Operator);
        $p = AgentProposal::create([
            'uuid' => (string) Str::uuid(), 'campaign_id' => $c->id, 'day_no' => 1, 'kind' => 'tank_maintenance', 'mode' => 'LIVE',
            'payload' => ['asset' => 'TK-RAW-1', 'minute' => 10, 'duration_min' => 60], 'rationale' => 'Uji mode LIVE', 'evidence' => [], 'evidence_hash' => str_repeat('0', 64),
            'created_by' => auth()->id(),
        ]);
        $this->postJson("/agent/proposals/{$p->uuid}/submit")->assertOk();
        $this->as(Role::Ppic);

        $this->postJson("/agent/proposals/{$p->uuid}/approve", ['reason' => 'Coba terapkan'])->assertStatus(422);
        $this->assertSame([], $c->days()->first()->plan);
        $this->assertSame('pending', $p->refresh()->status);
    }

    public function test_proposal_content_is_immutable_and_status_follows_the_flow(): void
    {
        $c = $this->campaign();
        $p = $this->pending($c);

        foreach (['payload' => ['asset' => 'TK-STO-1', 'minute' => 0, 'duration_min' => 30], 'rationale' => 'Diubah diam-diam', 'evidence_hash' => str_repeat('f', 64), 'created_by' => 999] as $field => $value) {
            try {
                $p->forceFill([$field => $value])->save();
                $this->fail("{$field} seharusnya immutable");
            } catch (LogicException) {
                $p->refresh();
            }
        }
        try {
            $p->forceFill(['status' => 'draft'])->save();
            $this->fail('pending tidak boleh kembali ke draft');
        } catch (LogicException) {
            $p->refresh();
        }
        $this->as(Role::Ppic);
        $this->postJson("/agent/proposals/{$p->uuid}/reject", ['reason' => 'Ditolak final'])->assertOk();
        foreach ([['status' => 'approved'], ['decision_reason' => 'Ganti alasan']] as $change) {
            try {
                $p->refresh()->forceFill($change)->save();
                $this->fail('keputusan final tidak boleh berubah');
            } catch (LogicException) {
            }
        }
        $this->expectException(LogicException::class);
        $p->refresh()->delete();
    }

    public function test_read_endpoints_follow_view_rules(): void
    {
        $c = $this->campaign();
        $p = $this->pending($c);

        $this->as(Role::Observer);
        $this->getJson("/agent/proposals?campaign_id={$c->id}")->assertOk()->assertJsonPath('proposals.0.id', $p->uuid)->assertJsonPath('proposals.0.status', 'pending');
        $this->getJson("/agent/proposals/{$p->uuid}")->assertOk()->assertJsonPath('proposal.evidence.whatif_id', 'wi-abcdef012345')
            ->assertJsonPath('proposal.evidence_hash', $p->evidence_hash);
        $this->getJson('/agent/proposals/'.Str::uuid())->assertNotFound();
        $this->getJson('/agent/proposals')->assertStatus(422);
        $this->as(Role::Driver);
        $this->getJson("/agent/proposals?campaign_id={$c->id}")->assertForbidden();
        auth()->logout();
        $this->getJson("/agent/proposals?campaign_id={$c->id}")->assertUnauthorized();
    }

    public function test_campaign_page_renders_assistant_drawer_with_label_and_role_flag(): void
    {
        $campaign = $this->campaign();

        $this->as(Role::Ppic);
        $this->get(route('campaigns.show', $campaign))->assertOk()
            ->assertSee('id="cp-drawer"', false)->assertSee('DATA SINTETIS | mode SIMULASI')
            ->assertSee('data-can-approve="1"', false)->assertSee('data-campaign-id="'.$campaign->id.'"', false);

        $this->as(Role::Operator);
        $this->get(route('campaigns.show', $campaign))->assertOk()
            ->assertSee('data-can-approve="0"', false);
    }
}
