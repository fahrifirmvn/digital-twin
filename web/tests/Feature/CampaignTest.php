<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\SimCommand;
use App\Models\SimRun;
use App\Models\User;
use App\Services\CampaignService;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

// Kampanye harian: hari berjalan, checkpoint berantai hash, pemulihan cabang.
class CampaignTest extends TestCase
{
    use RefreshDatabase;

    private int $engineStatus = 201;

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);
        Http::fake(fn () => Http::response([], $this->engineStatus));
    }

    private function as(Role $role): static
    {
        $this->actingAs(User::factory()->role($role)->create(['name' => 'Dewi']));

        return $this;
    }

    private function make(array $over = []): Campaign
    {
        $this->as(Role::Ppic);

        return app(CampaignService::class)->create(auth()->user(), $over + [
            'name' => 'Uji', 'seed' => 10, 'start_date' => '2026-03-01', 'config' => 'D', 'scenario' => 'normal',
            'params' => ['volume_ton' => 320, 'extra_bad' => 0], 'speed' => null,
        ]);
    }

    /** Engine melaporkan hari berjalan selesai. */
    private function finish(CampaignDay $day): void
    {
        $r = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
        $r['run_id'] = $day->fresh()->run_id;
        $this->postJson("/internal/runs/{$r['run_id']}/result", $r, ['X-Internal-Token' => 'secret'])->assertOk();
    }

    private function plan(Campaign $c, array $over = [])
    {
        return $this->post("/campaigns/{$c->id}/maintenance", $over + ['asset' => 'TK-RAW-3', 'start_min' => 1400, 'duration_min' => 120, 'reason' => 'Servis pompa']);
    }

    public function test_create_starts_with_planned_day_one(): void
    {
        $this->as(Role::Ppic);
        $this->post('/campaigns', [
            'name' => 'Kampanye A', 'seed' => 7, 'config' => 'D', 'scenario' => 'normal', 'volume_ton' => 320, 'extra_bad' => 0, 'speed' => '10', 'start_date' => '2026-03-01',
        ])->assertRedirect();

        $c = Campaign::firstOrFail();
        $this->assertSame(1, $c->current_day);
        $this->assertSame('planned', $c->days()->firstOrFail()->status);
        $this->assertSame(10.0, $c->speed);
    }

    public function test_only_ppic_and_admin_manage_but_viewers_can_read(): void
    {
        $c = $this->make();
        foreach ([Role::Operator, Role::Qa, Role::Observer] as $role) {
            $this->as($role)->get("/campaigns/{$c->id}")->assertOk();
            $this->post('/campaigns', ['name' => 'x'])->assertForbidden();
            $this->post("/campaigns/{$c->id}/start")->assertForbidden();
        }
        $this->as(Role::Driver);
        $this->get('/campaigns')->assertForbidden();
        $this->as(Role::Admin);
        $this->get("/campaigns/{$c->id}")->assertOk()->assertDontSee('SIMULASI');
    }

    public function test_plan_maintenance_validates_and_records_reason_and_actor(): void
    {
        $c = $this->make();
        $this->plan($c, ['asset' => 'TK-XX-1'])->assertSessionHasErrors('asset');
        $this->plan($c, ['asset' => 'TK-RAW-99'])->assertSessionHasErrors('asset');
        $this->plan($c, ['duration_min' => 5])->assertSessionHasErrors('duration_min');
        $this->plan($c, ['duration_min' => 900])->assertSessionHasErrors('duration_min');
        $this->plan($c, ['start_min' => 1440])->assertSessionHasErrors('start_min');
        $this->plan($c, ['reason' => 'ab'])->assertSessionHasErrors('reason');

        $this->plan($c)->assertRedirect();
        $this->plan($c)->assertSessionHasErrors('asset'); // tangki sama dua kali

        $entry = $c->days()->firstOrFail()->plan[0];
        $this->assertSame('TK-RAW-3', $entry['asset']);
        $this->assertSame('Servis pompa', $entry['reason']);
        $this->assertStringContainsString('Dewi', $entry['actor_label']);
    }

    public function test_cancel_maintenance(): void
    {
        $c = $this->make();
        $this->plan($c);
        $this->delete("/campaigns/{$c->id}/maintenance/0")->assertRedirect();
        $this->assertSame([], $c->days()->firstOrFail()->plan);
    }

    public function test_start_day_creates_run_with_commands_and_calls_engine(): void
    {
        $c = $this->make();
        $this->plan($c, ['start_min' => 480]);
        $this->post("/campaigns/{$c->id}/start")->assertRedirect();

        $day = $c->days()->firstOrFail();
        $this->assertSame('running', $day->status);
        $run = SimRun::findOrFail($day->run_id);
        $this->assertSame('campaign', $run->kind);
        $this->assertSame('running', $run->status);
        $this->assertSame($c->daySeed(1), $run->seed);
        $cmd = SimCommand::where('run_id', $run->id)->firstOrFail();
        $this->assertSame('tank_down', $cmd->kind);
        $this->assertSame('TK-RAW-3', $cmd->args['asset']);
        Http::assertSent(fn ($req) => str_contains($req->url(), 'engine.test') && $req['commands'][0]['kind'] === 'tank_down');

        // Hari berjalan tidak bisa diedit atau dimulai ulang.
        $this->plan($c, ['asset' => 'TK-RAW-4'])->assertSessionHasErrors('day');
    }

    public function test_engine_failure_marks_day_failed_and_allows_retry(): void
    {
        $c = $this->make();
        $this->engineStatus = 500;
        $this->post("/campaigns/{$c->id}/start")->assertSessionHasErrors('engine');
        $this->assertSame('failed', $c->days()->firstOrFail()->status);

        $this->engineStatus = 201;
        $this->post("/campaigns/{$c->id}/start")->assertRedirect();
        $this->assertSame('running', $c->days()->firstOrFail()->fresh()->status);
    }

    public function test_finished_result_closes_day_with_chained_checkpoint_and_carries_maintenance_over_midnight(): void
    {
        $c = $this->make();
        $this->plan($c); // menit 1400 + 120 menit: 40 menit di hari 1, 80 menit ke hari 2
        $this->post("/campaigns/{$c->id}/start");
        $day1 = $c->days()->firstOrFail();
        $this->finish($day1);

        $day1->refresh();
        $c->refresh();
        $this->assertSame('closed', $day1->status);
        $this->assertSame(64, strlen($day1->hash));
        $this->assertSame(hash('sha256', "\n".$day1->checkpoint), $day1->hash);
        $this->assertSame(40.0, (float) $day1->snapshot()['commands'][0]['duration_min']);
        $this->assertSame(2, $c->current_day);

        $day2 = $c->days()->where('day_no', 2)->firstOrFail();
        $this->assertSame('planned', $day2->status);
        $this->assertSame('TK-RAW-3', $day2->carry_in[0]['asset']);
        $this->assertSame(80.0, (float) $day2->carry_in[0]['duration_min']);
        $this->assertSame(0.0, (float) $day2->carry_in[0]['minute']);

        $this->post("/campaigns/{$c->id}/start");
        $cmd = SimCommand::where('run_id', $day2->fresh()->run_id)->firstOrFail();
        $this->assertEquals(0, $cmd->minute);
        $this->assertEquals(80, $cmd->args['duration_min']);
        $this->finish($day2);

        $day2->refresh();
        $this->assertSame($day1->hash, $day2->prev_hash);
        $this->assertSame(hash('sha256', $day1->hash."\n".$day2->checkpoint), $day2->hash);
        $this->assertSame(['ok' => true, 'broken_day' => null], app(CampaignService::class)->verify($c));
    }

    public function test_day_seeds_are_deterministic_per_day(): void
    {
        $c = $this->make(['seed' => 100]);
        $this->assertSame(100, $c->daySeed(1));
        $this->assertSame(104, $c->daySeed(5));
        $this->assertSame('2026-03-03', $c->dateOf(3));
    }

    public function test_closed_day_is_immutable_and_tampering_breaks_the_chain(): void
    {
        $c = $this->make();
        $this->post("/campaigns/{$c->id}/start");
        $day = $c->days()->firstOrFail();
        $this->finish($day);
        $day->refresh();

        try {
            $day->update(['checkpoint' => '{}']);
            $this->fail('Hari yang sudah ditutup tidak boleh diubah.');
        } catch (\LogicException) {
        }
        try {
            $day->delete();
            $this->fail('Hari yang sudah ditutup tidak boleh dihapus.');
        } catch (\LogicException) {
        }

        DB::table('campaign_days')->where('id', $day->id)->update(['checkpoint' => '{"v":1}']);
        $this->assertSame(['ok' => false, 'broken_day' => 1], app(CampaignService::class)->verify($c));
        $this->get("/campaigns/{$c->id}")->assertSee('Rantai checkpoint rusak');
    }

    public function test_branch_restores_from_closed_day_and_keeps_history(): void
    {
        $c = $this->make();
        $this->plan($c);
        $this->post("/campaigns/{$c->id}/start");
        $this->finish($c->days()->firstOrFail());

        $this->post("/campaigns/{$c->id}/branch", ['day' => 1])->assertRedirect();
        $b = Campaign::where('parent_campaign_id', $c->id)->firstOrFail();
        $this->assertSame(1, $b->branched_from_day);
        $this->assertSame(2, $b->current_day);
        $this->assertSame(['ok' => true, 'broken_day' => null], app(CampaignService::class)->verify($b));
        $this->assertSame('planned', $b->days()->where('day_no', 2)->firstOrFail()->status);
        $this->assertSame('TK-RAW-3', $b->days()->where('day_no', 2)->firstOrFail()->carry_in[0]['asset']);
        // Kampanye asal tidak berubah.
        $this->assertSame(2, $c->fresh()->current_day);

        $this->post("/campaigns/{$c->id}/branch", ['day' => 2])->assertSessionHasErrors('day'); // hari 2 belum ditutup
    }

    public function test_autoplay_starts_next_day_after_close(): void
    {
        $c = $this->make();
        $this->post("/campaigns/{$c->id}/autoplay", ['on' => 1])->assertRedirect();
        $this->assertSame('running', $c->days()->where('day_no', 1)->firstOrFail()->status);

        $this->finish($c->days()->where('day_no', 1)->firstOrFail());
        $this->assertSame('running', $c->days()->where('day_no', 2)->firstOrFail()->status);
    }

    public function test_failed_result_stops_autoplay(): void
    {
        $c = $this->make();
        $this->post("/campaigns/{$c->id}/autoplay", ['on' => 1]);
        $run = $c->days()->firstOrFail()->run_id;
        $this->postJson("/internal/runs/{$run}/result", ['status' => 'failed', 'run_id' => $run, 'error' => 'boom'], ['X-Internal-Token' => 'secret'])->assertOk();

        $this->assertSame('failed', $c->days()->firstOrFail()->status);
        $this->assertFalse($c->fresh()->autoplay);
    }

    public function test_day_limit_is_enforced(): void
    {
        config(['twin.campaign.max_days' => 1]);
        $c = $this->make();
        $this->post("/campaigns/{$c->id}/start");
        $this->finish($c->days()->firstOrFail());

        $this->assertSame(1, $c->days()->count()); // tidak ada hari ke-2
    }

    public function test_state_endpoint_reports_current_day(): void
    {
        $c = $this->make();
        $this->getJson("/campaigns/{$c->id}/state")->assertOk()->assertJson(['current_day' => 1, 'status' => 'planned']);
    }
}
