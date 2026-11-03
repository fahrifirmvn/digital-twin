<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\Layout;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

// Mode membangun (P7a): denah tersimpan, izin, dan run yang membawa susunan pabrik ke engine dan halaman Twin.
class BuildLayoutTest extends TestCase
{
    use RefreshDatabase;

    private function user(Role $role): User
    {
        return User::factory()->role($role)->create();
    }

    private function plant(array $over = []): array
    {
        return $over + ['n_bays' => 2, 'n_analysts' => 2, 'n_raw_tanks' => 15, 'n_degassing' => 2, 'n_thermal' => 2, 'n_separators' => 2, 'n_storage_tanks' => 6, 'n_sterilizers' => 5];
    }

    public function test_only_ppic_and_admin_open_the_build_page(): void
    {
        $this->actingAs($this->user(Role::Ppic))->get('/twin/build')->assertOk()->assertSee('Susunan pabrik');
        $this->actingAs($this->user(Role::Admin))->get('/twin/build')->assertOk();
        foreach ([Role::Qa, Role::Operator, Role::Observer, Role::Driver] as $role) {
            $this->actingAs($this->user($role))->get('/twin/build')->assertForbidden();
        }
    }

    public function test_save_layout_stores_plant_for_the_owner(): void
    {
        $ppic = $this->user(Role::Ppic);

        $this->actingAs($ppic)->postJson('/layouts', ['name' => 'Bay tambahan', 'plant' => $this->plant()])
            ->assertCreated()->assertJsonPath('plant.n_bays', 2)->assertJsonPath('can_delete', true);

        $layout = Layout::first();
        $this->assertSame($ppic->id, $layout->user_id);
        $this->assertSame(['version' => 1, 'plant' => $this->plant()], $layout->spec);
    }

    public function test_save_layout_rejects_out_of_range_and_missing_counts(): void
    {
        $ppic = $this->user(Role::Ppic);

        $this->actingAs($ppic)->postJson('/layouts', ['name' => 'Terlalu besar', 'plant' => $this->plant(['n_bays' => 4])])->assertJsonValidationErrors('plant.n_bays');
        $this->actingAs($ppic)->postJson('/layouts', ['name' => 'Nol', 'plant' => $this->plant(['n_sterilizers' => 0])])->assertJsonValidationErrors('plant.n_sterilizers');
        $this->actingAs($ppic)->postJson('/layouts', ['name' => 'Kurang', 'plant' => ['n_bays' => 3]])->assertJsonValidationErrors('plant.n_analysts');
        $this->actingAs($ppic)->postJson('/layouts', ['name' => 'ab', 'plant' => $this->plant()])->assertJsonValidationErrors('name');
        $this->assertSame(0, Layout::count());
    }

    public function test_save_and_delete_need_the_build_ability(): void
    {
        $layout = Layout::create(['name' => 'Milik PPIC', 'user_id' => $this->user(Role::Ppic)->id, 'spec' => ['version' => 1, 'plant' => $this->plant()]]);

        $obs = $this->user(Role::Observer);
        $this->actingAs($obs)->postJson('/layouts', ['name' => 'Coba', 'plant' => $this->plant()])->assertForbidden();
        $this->actingAs($obs)->deleteJson("/layouts/{$layout->id}")->assertForbidden();
        $this->assertSame(1, Layout::count());
    }

    public function test_only_owner_or_admin_deletes_a_layout(): void
    {
        $owner = $this->user(Role::Ppic);
        $layout = Layout::create(['name' => 'Milik PPIC', 'user_id' => $owner->id, 'spec' => ['version' => 1, 'plant' => $this->plant()]]);

        $this->actingAs($this->user(Role::Ppic))->deleteJson("/layouts/{$layout->id}")->assertForbidden();
        $this->assertSame(1, Layout::count());

        $this->actingAs($this->user(Role::Admin))->deleteJson("/layouts/{$layout->id}")->assertOk();
        $this->assertSame(0, Layout::count());

        $mine = Layout::create(['name' => 'Milik sendiri', 'user_id' => $owner->id, 'spec' => ['version' => 1, 'plant' => $this->plant()]]);
        $this->actingAs($owner)->deleteJson("/layouts/{$mine->id}")->assertOk();
    }

    public function test_run_from_build_goes_to_twin_and_carries_only_changed_plant(): void
    {
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
        Http::fake(['engine.test/*' => Http::response(['run_id' => 1], 201)]);

        $this->actingAs($this->user(Role::Ppic))->post('/runs', ['seed' => 2, 'volume_ton' => 320, 'extra_bad' => 0, 'config' => 'B', 'go' => 'twin', 'plant' => ['n_bays' => 2]])
            ->assertRedirect('/runs/1/twin');

        $run = SimRun::first();
        $this->assertSame(['n_bays' => 2], $run->plant());
        Http::assertSent(fn ($req) => ($req['plant'] ?? null) === ['n_bays' => 2]);
    }

    public function test_twin_page_embeds_the_run_plant(): void
    {
        $run = SimRun::create(['kind' => 'live', 'seed' => 1, 'status' => 'finished', 'config_snapshot' => ['config' => 'B', 'scenario' => 'normal', 'params' => ['plant' => ['n_bays' => 7]]]]);
        $plain = SimRun::create(['kind' => 'live', 'seed' => 1, 'status' => 'finished', 'config_snapshot' => ['config' => 'B', 'scenario' => 'normal', 'params' => []]]);
        $ppic = $this->user(Role::Ppic);

        $this->actingAs($ppic)->get("/runs/{$run->id}/twin")->assertOk()->assertSee('data-plant="{&quot;n_bays&quot;:7}"', false)->assertSee('Bangun pabrik');
        $this->actingAs($ppic)->get("/runs/{$plain->id}/twin")->assertOk()->assertSee('data-plant="{}"', false)->assertSee('data-anomaly="null"', false);
    }

    public function test_twin_page_embeds_the_ai_anomaly(): void
    {
        $run = SimRun::create(['kind' => 'live', 'seed' => 1, 'status' => 'finished', 'config_snapshot' => ['config' => 'B', 'scenario' => 'normal', 'params' => []]]);
        $run->ai_result = ['anomaly' => ['is_anomaly' => true, 'flags' => ['FLOW_RATE_ANOMALY']]];
        $run->save();

        $this->actingAs($this->user(Role::Ppic))->get("/runs/{$run->id}/twin")->assertOk()->assertSee('FLOW_RATE_ANOMALY', false);
    }
}
