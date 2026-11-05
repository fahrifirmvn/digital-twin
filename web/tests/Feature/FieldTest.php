<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimRun;
use App\Models\User;
use App\Services\FieldTasks;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class FieldTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);
        $sample = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
        SimRun::forceCreate(['id' => 1, 'kind' => 'live', 'seed' => 1, 'status' => 'running']);
        $this->postJson('/internal/runs/1/result', $sample, ['X-Internal-Token' => 'secret'])->assertOk();
    }

    private function as(Role $role): static
    {
        return $this->actingAs(User::factory()->role($role)->create());
    }

    private function item(string $kind, string $subject, array $over = []): array
    {
        return $over + ['uuid' => (string) Str::uuid(), 'run_id' => 1, 'kind' => $kind, 'subject' => $subject, 'client_at' => '2026-10-28T01:00:00Z'];
    }

    public function test_pages_follow_role_matrix(): void
    {
        $this->as(Role::Driver)->get('/driver')->assertOk()->assertSee('id="field"', false);
        $this->get('/operator')->assertForbidden();
        $this->as(Role::Operator)->get('/operator')->assertOk()->assertSee('sim-slider', false);
        foreach ([Role::Ppic, Role::Qa, Role::Observer] as $role) {
            $this->as($role)->get('/driver')->assertForbidden();
            $this->get('/field/manifest')->assertForbidden();
        }
        auth()->logout();
        $this->get('/driver')->assertRedirect('/login');
    }

    public function test_driver_manifest_has_no_quality_data_and_no_tasks(): void
    {
        $json = $this->as(Role::Driver)->getJson('/field/manifest')->assertOk()->json();

        $this->assertSame(1, $json['run']['id']);
        $this->assertNotEmpty($json['trucks']);
        $this->assertSame(['code', 'eta', 'farm_code'], collect($json['trucks'][0])->keys()->sort()->values()->all());
        $this->assertSame([], $json['tasks']);
    }

    public function test_operator_manifest_has_tasks_derived_from_plan(): void
    {
        $json = $this->as(Role::Operator)->getJson('/field/manifest')->assertOk()->json();

        $this->assertNotEmpty($json['tasks']);
        $this->assertMatchesRegularExpression('/^RT-\d+:(unload|ster|fill)$/', $json['tasks'][0]['key']);
        $starts = array_column($json['tasks'], 'start');
        $sorted = $starts;
        sort($sorted);
        $this->assertSame($sorted, $starts);
    }

    public function test_tasks_merge_versions_so_replans_do_not_drop_earlier_trucks(): void
    {
        $scheduleId = DB::table('schedules')->where('run_id', 1)->value('id');
        $before = collect((new FieldTasks)->forRun(1));
        $truck = $before->first()['truck'];
        $version = DB::table('schedule_versions')->where('schedule_id', $scheduleId)->max('version') + 1;
        DB::table('schedule_versions')->insert([
            'schedule_id' => $scheduleId, 'version' => $version, 'status' => 'proposed', 'config' => 'D', 'created_by' => 'replan',
            'plan' => json_encode(['trucks' => [['code' => $truck, 'bay' => 'BAY-9', 'unload_start' => '2026-10-28T00:01:00Z']]]),
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $after = collect((new FieldTasks)->forRun(1));

        $this->assertSame($before->pluck('truck')->unique()->sort()->values()->all(), $after->pluck('truck')->unique()->sort()->values()->all());
        $this->assertSame('BAY-9', $after->firstWhere('key', "{$truck}:unload")['asset']);
    }

    public function test_check_in_is_idempotent_by_uuid_and_by_subject(): void
    {
        $code = DB::table('tankers')->value('code');
        $item = $this->item('check_in', $code);

        $this->as(Role::Driver)->postJson('/field/confirmations', ['items' => [$item]])
            ->assertOk()->assertJsonPath("results.{$item['uuid']}", 'recorded');
        $this->postJson('/field/confirmations', ['items' => [$item]])
            ->assertOk()->assertJsonPath("results.{$item['uuid']}", 'duplicate');
        $other = $this->item('check_in', $code);
        $this->postJson('/field/confirmations', ['items' => [$other]])
            ->assertOk()->assertJsonPath("results.{$other['uuid']}", 'duplicate');

        $this->assertSame(1, DB::table('field_confirmations')->count());
        $this->assertContains("check_in|{$code}", $this->getJson('/field/manifest')->json('confirmed'));
    }

    public function test_batch_reports_each_item_and_rejects_unknown_subjects(): void
    {
        $code = DB::table('tankers')->value('code');
        $good = $this->item('check_in', $code);
        $bad = $this->item('check_in', 'RT-999');
        $wrongRun = $this->item('check_in', $code, ['run_id' => 7]);

        $this->as(Role::Driver)->postJson('/field/confirmations', ['items' => [$good, $bad, $wrongRun]])->assertOk()
            ->assertJsonPath("results.{$good['uuid']}", 'recorded')
            ->assertJsonPath("results.{$bad['uuid']}", 'rejected')
            ->assertJsonPath("results.{$wrongRun['uuid']}", 'rejected');
    }

    public function test_handoff_only_for_operator_and_only_for_planned_tasks(): void
    {
        $key = $this->as(Role::Operator)->getJson('/field/manifest')->json('tasks.0.key');
        $item = $this->item('handoff', $key);
        $bogus = $this->item('handoff', 'RT-001:nonsense');

        $this->as(Role::Driver)->postJson('/field/confirmations', ['items' => [$item]])
            ->assertOk()->assertJsonPath("results.{$item['uuid']}", 'forbidden');
        $this->assertSame(0, DB::table('field_confirmations')->count());

        $this->as(Role::Operator)->postJson('/field/confirmations', ['items' => [$item, $bogus]])->assertOk()
            ->assertJsonPath("results.{$item['uuid']}", 'recorded')
            ->assertJsonPath("results.{$bogus['uuid']}", 'rejected');
    }

    public function test_payload_is_validated(): void
    {
        $this->as(Role::Driver)->postJson('/field/confirmations', ['items' => []])->assertUnprocessable();
        $this->postJson('/field/confirmations', ['items' => [['uuid' => 'x', 'run_id' => 1, 'kind' => 'hack', 'subject' => 'a', 'client_at' => 'b']]])
            ->assertUnprocessable();
        $this->postJson('/field/confirmations', ['items' => array_fill(0, 51, $this->item('check_in', 'RT-001'))])->assertUnprocessable();
    }

    public function test_observer_cannot_post(): void
    {
        $this->as(Role::Observer)->postJson('/field/confirmations', ['items' => [$this->item('check_in', 'RT-001')]])->assertForbidden();
    }

    public function test_manifest_and_check_in_work_on_running_run(): void
    {
        SimRun::where('id', 1)->update(['status' => 'running']);
        $json = $this->as(Role::Driver)->getJson('/field/manifest')->assertOk()->json();
        $this->assertSame(1, $json['run']['id']);
        $this->assertSame('running', $json['run']['status']);

        $code = DB::table('tankers')->value('code');
        $item = $this->item('check_in', $code);
        $this->postJson('/field/confirmations', ['items' => [$item]])
            ->assertOk()->assertJsonPath("results.{$item['uuid']}", 'recorded');
    }
}
