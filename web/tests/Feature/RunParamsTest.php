<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class RunParamsTest extends TestCase
{
    use RefreshDatabase;

    private array $base = ['seed' => 3, 'volume_ton' => 320, 'extra_bad' => 0];

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
        Http::fake(['engine.test/*' => Http::response(['run_id' => 1], 201)]);
    }

    private function as(Role $role): static
    {
        return $this->actingAs(User::factory()->role($role)->create());
    }

    private function finished(array $params = [], string $config = 'A', string $scenario = 'normal'): SimRun
    {
        $sid = DB::table('scenarios')->insertGetId(['name' => 'x', 'params' => '{}', 'seed' => 3, 'kpi_result' => json_encode(['truck_wait_min' => ['mean' => 10, 'p90' => 10]]), 'created_at' => now(), 'updated_at' => now()]);

        return SimRun::forceCreate(['kind' => 'live', 'seed' => 3, 'status' => 'finished', 'scenario_id' => $sid,
            'config_snapshot' => ['config' => $config, 'scenario' => $scenario, 'params' => ['volume_ton' => 320, 'extra_bad' => 0] + $params]]);
    }

    public function test_params_are_validated_forwarded_and_only_changes_are_stored(): void
    {
        $this->as(Role::Ppic);
        $bad = [['filling_tph' => 99], ['filling_tph' => 1], ['bay_flow_tph' => 'x'], ['holding_max_min' => 9999], ['maintenance' => array_fill(0, 7, ['asset' => 'STE-1', 'start_clock' => '08:00', 'duration_min' => 30])],
            ['maintenance' => [['asset' => 'BAY-1', 'start_clock' => '08:00', 'duration_min' => 30]]],
            ['maintenance' => [['asset' => 'STE-1', 'start_clock' => '08:00', 'duration_min' => 5]]]];
        foreach ($bad as $p) {
            $this->post('/runs', $this->base + ['params' => $p])->assertSessionHasErrors();
        }
        $this->assertSame(0, SimRun::count());

        $this->post('/runs', $this->base + ['params' => ['filling_tph' => '8', 'bay_flow_tph' => '40', 'lasers' => 3]])->assertSessionHasNoErrors();
        $this->assertSame(['filling_tph' => 8], SimRun::first()->config_snapshot['params']['params']);
        Http::assertSent(fn ($req) => $req['params'] === ['filling_tph' => 8]);

        $this->post('/runs', $this->base + ['params' => ['filling_tph' => '10']])->assertSessionHasNoErrors();
        $this->assertArrayNotHasKey('params', SimRun::latest('id')->first()->config_snapshot['params']);
        Http::assertSent(fn ($req) => ! isset($req['params']));
    }

    public function test_sku_policy_is_validated_and_only_stored_when_not_default(): void
    {
        $this->as(Role::Ppic);
        $this->post('/runs', $this->base + ['params' => ['sku_policy' => 'bebas']])->assertSessionHasErrors('params.sku_policy');
        $this->assertSame(0, SimRun::count());

        $this->post('/runs', $this->base + ['params' => ['sku_policy' => 'dedicated']])->assertSessionHasNoErrors();
        $this->assertSame(['sku_policy' => 'dedicated'], SimRun::first()->config_snapshot['params']['params']);
        Http::assertSent(fn ($req) => $req['params'] === ['sku_policy' => 'dedicated']);

        $this->post('/runs', $this->base + ['params' => ['sku_policy' => 'free']])->assertSessionHasNoErrors();
        $this->assertArrayNotHasKey('params', SimRun::latest('id')->first()->config_snapshot['params']);
    }

    public function test_orders_and_milk_use_are_validated_and_forwarded(): void
    {
        $this->as(Role::Ppic);
        $bad = [
            ['orders' => [['sku' => 'UHT-XXX', 'ton' => 10]]],
            ['orders' => [['sku' => 'UHT-FULL-200', 'ton' => 0]]],
            ['orders' => [['sku' => 'UHT-FULL-200', 'ton' => 9999]]],
            ['orders' => array_fill(0, 7, ['sku' => 'UHT-FULL-200', 'ton' => 10])],
            ['milk_use_flavour_pct' => 10],
            ['milk_use_full_pct' => 120],
        ];
        foreach ($bad as $p) {
            $this->post('/runs', $this->base + ['params' => $p])->assertSessionHasErrors();
        }
        $this->post('/runs', $this->base + ['params' => ['orders' => [['sku' => 'UHT-FULL-200', 'ton' => '']]]])->assertSessionHasErrors('params.orders.0.sku');
        $this->assertSame(0, SimRun::count());

        $this->post('/runs', $this->base + ['params' => ['milk_use_flavour_pct' => '85', 'orders' => [['sku' => 'UHT-CHOC-200', 'ton' => '40'], ['sku' => '', 'ton' => '']]]])->assertSessionHasNoErrors();
        $this->assertEquals(['milk_use_flavour_pct' => 85, 'orders' => [['sku' => 'UHT-CHOC-200', 'ton' => 40.0]]], SimRun::first()->config_snapshot['params']['params']);
    }

    public function test_wear_params_are_validated_and_forwarded(): void
    {
        $this->as(Role::Ppic);
        foreach ([['fouling_max_min' => 30], ['shelf_life_days' => 400], ['dispatch_lead_days' => -1]] as $p) {
            $this->post('/runs', $this->base + ['params' => $p])->assertSessionHasErrors();
        }
        $this->assertSame(0, SimRun::count());

        $this->post('/runs', $this->base + ['params' => ['fouling_max_min' => '240', 'shelf_life_days' => '120', 'dispatch_lead_days' => '20']])->assertSessionHasNoErrors();
        $this->assertEquals(['fouling_max_min' => 240, 'shelf_life_days' => 120, 'dispatch_lead_days' => 20], SimRun::first()->config_snapshot['params']['params']);
    }

    public function test_cip_order_and_maintenance_target_are_cross_checked(): void
    {
        $this->as(Role::Ppic);
        $this->post('/runs', $this->base + ['params' => ['cip_min_minutes' => 100, 'cip_max_minutes' => 40]])->assertSessionHasErrors('params.cip_min_minutes');
        $this->post('/runs', $this->base + ['plant' => ['n_sterilizers' => 2], 'params' => ['maintenance' => [['asset' => 'STE-3', 'start_clock' => '08:00', 'duration_min' => 60]]]])
            ->assertSessionHasErrors('params.maintenance.0.asset');
        $this->assertSame(0, SimRun::count());
    }

    public function test_maintenance_clock_is_converted_to_minutes_since_0600(): void
    {
        $this->as(Role::Ppic);
        $rows = [['asset' => 'STE-2', 'start_clock' => '08:30', 'duration_min' => 90], ['asset' => '', 'start_clock' => '', 'duration_min' => ''], ['asset' => 'STE-1', 'start_clock' => '02:00', 'duration_min' => 60]];
        $this->post('/runs', $this->base + ['params' => ['maintenance' => $rows]])->assertSessionHasNoErrors();

        $this->assertEquals([
            ['asset' => 'STE-2', 'start_min' => 150.0, 'duration_min' => 90.0],
            ['asset' => 'STE-1', 'start_min' => 1200.0, 'duration_min' => 60.0],
        ], SimRun::first()->config_snapshot['params']['params']['maintenance']);
    }

    public function test_retest_starts_a_and_b_on_the_same_day_with_new_params(): void
    {
        $run = $this->finished(['plant' => ['n_bays' => 6]], 'C', 'truck_surge');
        $this->as(Role::Ppic)->post("/runs/{$run->id}/retest", ['params' => ['filling_tph' => '8']])
            ->assertRedirect()->assertSessionHas('status');

        $new = SimRun::where('id', '!=', $run->id)->orderBy('id')->get();
        $this->assertSame(['A', 'B'], $new->map(fn ($r) => $r->config_snapshot['config'])->all());
        foreach ($new as $r) {
            $this->assertSame('truck_surge', $r->config_snapshot['scenario']);
            $this->assertSame(3, $r->seed);
            $this->assertSame(['n_bays' => 6], $r->config_snapshot['params']['plant']);
            $this->assertSame(['filling_tph' => 8], $r->config_snapshot['params']['params']);
        }
        Http::assertSentCount(2);
        Http::assertSent(fn ($req) => $req['params'] === ['filling_tph' => 8] && $req['plant'] === ['n_bays' => 6] && $req['scenario'] === 'truck_surge');
    }

    public function test_retest_is_restricted_and_validated(): void
    {
        $run = $this->finished();
        foreach ([Role::Qa, Role::Operator, Role::Driver, Role::Observer] as $role) {
            $this->as($role)->post("/runs/{$run->id}/retest", ['params' => ['filling_tph' => 8]])->assertForbidden();
        }
        $this->as(Role::Ppic)->post("/runs/{$run->id}/retest", ['params' => ['filling_tph' => 99]])->assertSessionHasErrors('params.filling_tph');
        $this->assertSame(1, SimRun::count());
    }

    public function test_comparison_separates_runs_with_different_params(): void
    {
        $this->withoutVite();
        $a = $this->finished(['params' => ['filling_tph' => 8]], 'A');
        $other = $this->finished([], 'B'); // parameter bawaan: tidak ikut
        $b = $this->finished(['params' => ['filling_tph' => 8]], 'B');

        $res = $this->as(Role::Ppic)->get("/runs/{$a->id}")->assertOk();
        $res->assertSee("/runs/{$b->id}", false)->assertDontSee('#'.$other->id.'</a>', false);
    }

    public function test_panel_shows_current_values_to_ppic_only(): void
    {
        $this->withoutVite();
        $run = SimRun::forceCreate(['kind' => 'live', 'seed' => 3, 'status' => 'running', 'config_snapshot' => ['config' => 'A', 'scenario' => 'normal',
            'params' => ['volume_ton' => 320, 'extra_bad' => 0, 'params' => ['filling_tph' => 8, 'maintenance' => [['asset' => 'STE-2', 'start_min' => 150, 'duration_min' => 90]]]]]]);

        $this->as(Role::Ppic)->get("/runs/{$run->id}")->assertOk()
            ->assertSee('Parameter operasional')->assertSee('nilai demo, bukan SOP')
            ->assertSee('name="params[filling_tph]" value="8"', false)->assertSee('value="08:30"', false)
            ->assertSee('Uji ulang A dan B');
        $this->as(Role::Qa)->get("/runs/{$run->id}")->assertOk()->assertDontSee('Parameter operasional');
    }
}
