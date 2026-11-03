<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class RunStartTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
    }

    private function as(Role $role): static
    {
        return $this->actingAs(User::factory()->role($role)->create());
    }

    public function test_ppic_starts_run_and_engine_receives_allocated_id(): void
    {
        Http::fake(['engine.test/*' => Http::response(['run_id' => 1], 201)]);

        $res = $this->as(Role::Ppic)->post('/runs', ['seed' => 3, 'volume_ton' => 320, 'extra_bad' => 1]);

        $run = SimRun::first();
        $res->assertRedirect("/runs/{$run->id}");
        $this->assertSame('running', $run->status);
        Http::assertSent(fn ($req) => $req->url() === 'http://engine.test/v1/runs'
            && $req->hasHeader('X-Internal-Token', 'secret')
            && $req['run_id'] === $run->id && $req['seed'] === 3 && $req['extra_bad'] === 1);
    }

    public function test_engine_failure_marks_run_failed(): void
    {
        Http::fake(['engine.test/*' => Http::response('x', 500)]);

        $this->as(Role::Ppic)->post('/runs', ['seed' => 1, 'volume_ton' => 320, 'extra_bad' => 0])
            ->assertRedirect('/runs')->assertSessionHasErrors('engine');
        $this->assertSame('failed', SimRun::first()->status);
    }

    public function test_only_roles_allowed_to_run_scenarios(): void
    {
        Http::fake();
        $body = ['seed' => 1, 'volume_ton' => 320, 'extra_bad' => 0];

        foreach ([Role::Qa, Role::Operator, Role::Driver, Role::Observer] as $role) {
            $this->as($role)->post('/runs', $body)->assertForbidden();
        }
        $this->as(Role::Admin)->post('/runs', $body)->assertRedirect();
        $this->assertSame(1, SimRun::count());
    }

    public function test_pages_render_per_role(): void
    {
        $this->withoutVite();
        $run = SimRun::forceCreate(['kind' => 'live', 'seed' => 1, 'status' => 'running', 'config_snapshot' => json_encode(['params' => ['volume_ton' => 320, 'extra_bad' => 0]])]);

        $this->as(Role::Ppic)->get('/runs')->assertOk()->assertSee('Jalankan uji')->assertSee('Run terbaru');
        $this->get('/dashboard')->assertOk()->assertSee('Dashboard')->assertSee(route('twin', ['run' => $run->id]), false);
        $this->get("/runs/{$run->id}")->assertOk()->assertSee('Dashboard Monitoring')->assertSee('id="gantt"', false)
            ->assertSee('id="twin-preview"', false)->assertSee('Buka Digital Twin')
            ->assertSee(route('runs.twin', $run->id), false)->assertDontSee('id="twin3d"', false);
        $this->get("/runs/{$run->id}/twin")->assertOk()->assertSee('id="twin"', false)->assertSee('id="twin3d"', false)
            ->assertDontSee('id="view-3d"', false)->assertSee('id="day-end"', false)->assertSee('Statistik Langsung')
            ->assertSee('Pelacakan Truk')->assertSee('Kontrol peta')->assertSee(route('runs.show', $run->id), false);

        $this->as(Role::Qa)->get('/runs')->assertOk()->assertDontSee('Jalankan uji');
        $this->as(Role::Driver)->get('/dashboard')->assertOk()->assertDontSee('Run terbaru');
        $this->get("/runs/{$run->id}")->assertForbidden();
        $this->get("/runs/{$run->id}/twin")->assertForbidden();
    }

    public function test_config_is_forwarded_to_engine_and_stored_in_snapshot(): void
    {
        Http::fake(['engine.test/*' => Http::response(['run_id' => 1], 201)]);

        $this->as(Role::Ppic)->post('/runs', ['seed' => 3, 'volume_ton' => 320, 'extra_bad' => 0, 'config' => 'C']);

        $this->assertSame('C', SimRun::first()->config_snapshot['config']);
        Http::assertSent(fn ($req) => $req['config'] === 'C');

        Http::fake(['engine.test/*' => Http::response(['run_id' => 1], 201)]);
        $this->post('/runs', ['seed' => 3, 'volume_ton' => 320, 'extra_bad' => 0, 'config' => 'D', 'scenario' => 'truck_surge'])->assertSessionHasNoErrors();
        $this->assertSame('truck_surge', SimRun::latest('id')->first()->config_snapshot['scenario']);
        Http::assertSent(fn ($req) => $req['config'] === 'D' && $req['scenario'] === 'truck_surge');

        Http::fake();
        $this->post('/runs', ['seed' => 3, 'volume_ton' => 320, 'extra_bad' => 0, 'config' => 'Z'])->assertSessionHasErrors('config');
        $this->post('/runs', ['seed' => 3, 'volume_ton' => 320, 'extra_bad' => 0, 'scenario' => 'nope'])->assertSessionHasErrors('scenario');
    }

    public function test_run_page_compares_configs_for_the_same_day(): void
    {
        $this->withoutVite();
        $mk = function (string $cfg, int $seed, float $wait, string $sc = 'normal') {
            $scenario = DB::table('scenarios')->insertGetId([
                'name' => "t{$cfg}", 'params' => '{}', 'seed' => $seed,
                'kpi_result' => json_encode(['truck_wait_min' => ['mean' => $wait, 'p90' => $wait + 10], 'changeover_min' => $wait]),
                'created_at' => now(), 'updated_at' => now(),
            ]);

            return SimRun::forceCreate([
                'kind' => 'live', 'seed' => $seed, 'status' => 'finished', 'scenario_id' => $scenario,
                'config_snapshot' => ['config' => $cfg, 'scenario' => $sc, 'params' => ['volume_ton' => 320, 'extra_bad' => 0]],
            ]);
        };
        $a = $mk('A', 5, 100.0);
        $mk('C', 5, 90.0);
        $mk('B', 6, 1.0); // seed lain: tidak ikut
        $mk('D', 5, 1.0, 'truck_surge'); // skenario lain: tidak ikut

        $this->as(Role::Ppic)->get("/runs/{$a->id}")->assertOk()
            ->assertSee('Perbandingan konfigurasi')->assertSee('(-10)')->assertDontSee('(-99)');
    }

    public function test_plant_counts_are_validated_forwarded_and_stored(): void
    {
        Http::fake(['engine.test/*' => Http::response(['run_id' => 1], 201)]);
        $base = ['seed' => 3, 'volume_ton' => 320, 'extra_bad' => 0];
        $this->as(Role::Ppic);

        foreach ([['n_bays' => 0], ['n_bays' => 4], ['n_raw_tanks' => 'x'], ['n_bays' => 2.5]] as $bad) {
            $this->post('/runs', $base + ['plant' => $bad])->assertSessionHasErrors();
        }
        $this->assertSame(0, SimRun::count());

        $this->post('/runs', $base + ['plant' => ['n_bays' => '2', 'n_raw_tanks' => null, 'lasers' => 3]])->assertSessionHasNoErrors();
        $this->assertSame(['n_bays' => 2], SimRun::first()->config_snapshot['params']['plant']);
        Http::assertSent(fn ($req) => $req['plant'] === ['n_bays' => 2]);

        $this->post('/runs', $base + ['plant' => ['n_bays' => null]])->assertSessionHasNoErrors();
        $this->assertArrayNotHasKey('plant', SimRun::latest('id')->first()->config_snapshot['params']);
        Http::assertSent(fn ($req) => ! isset($req['plant']));
    }

    public function test_comparison_ignores_runs_with_another_plant(): void
    {
        $this->withoutVite();
        $mk = function (string $cfg, ?array $plant, float $wait) {
            $scenario = DB::table('scenarios')->insertGetId([
                'name' => "t{$cfg}", 'params' => '{}', 'seed' => 5,
                'kpi_result' => json_encode(['truck_wait_min' => ['mean' => $wait, 'p90' => $wait], 'changeover_min' => $wait]),
                'created_at' => now(), 'updated_at' => now(),
            ]);
            $params = ['volume_ton' => 320, 'extra_bad' => 0] + ($plant ? ['plant' => $plant] : []);

            return SimRun::forceCreate([
                'kind' => 'live', 'seed' => 5, 'status' => 'finished', 'scenario_id' => $scenario,
                'config_snapshot' => ['config' => $cfg, 'scenario' => 'normal', 'params' => $params],
            ]);
        };
        $a = $mk('A', null, 100.0);
        $mk('C', null, 90.0);
        $mk('B', ['n_bays' => 2], 1.0); // pabrik lain: tidak ikut

        $this->as(Role::Ppic)->get("/runs/{$a->id}")->assertOk()->assertSee('(-10)')->assertDontSee('(-99)');
    }

    public function test_input_is_validated(): void
    {
        Http::fake();
        $this->as(Role::Ppic);

        foreach ([['volume_ton' => 10], ['volume_ton' => 9999], ['extra_bad' => 11], ['seed' => 'x']] as $bad) {
            $this->post('/runs', $bad + ['seed' => 1, 'volume_ton' => 320, 'extra_bad' => 0])->assertSessionHasErrors();
        }
        $this->assertSame(0, SimRun::count());
        Http::assertNothingSent();
    }
}
