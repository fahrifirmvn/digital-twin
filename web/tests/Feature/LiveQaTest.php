<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\OperationQaDecision;
use App\Models\SimRun;
use App\Models\User;
use App\Services\AuditLogger;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Tests\TestCase;

class LiveQaTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        $this->seed(MasterDataSeeder::class);
        config(['services.engine.url' => 'http://engine.test', 'services.engine.token' => 'secret']);
        Http::fake(fn () => Http::response([], 201));
        $this->actingAs(User::factory()->role(Role::Ppic)->create());
        $this->postJson('/operasi/lanjut')->assertOk();
        $this->actingAs(User::factory()->role(Role::Qa)->create());
    }

    private function body(array $over = []): array
    {
        return array_replace([
            'request_id' => (string) Str::uuid(), 'run_id' => SimRun::sole()->id,
            'truck' => 'RT-001', 'action' => 'reject', 'reason' => 'Tidak memenuhi spesifikasi',
            'disposition' => 'return_supplier',
        ], $over);
    }

    private function fakeQa(): void
    {
        Http::swap(new Factory);
        Http::fake(fn ($r) => Http::response(['status' => 'accepted', 'request_id' => $r['request_id'], 'minute' => 80], 200));
    }

    public function test_qa_decision_is_durable_idempotent_and_actor_is_server_owned(): void
    {
        $this->mock(AuditLogger::class)->shouldReceive('record')->once()
            ->withArgs(fn ($type, $id, $action, $payload) => $type === 'user' && $action === 'operation.qa_accepted' && $payload['disposition'] === 'return_supplier');
        $this->fakeQa();
        $body = $this->body();
        $this->postJson('/operasi/qa', $body)->assertCreated()->assertJsonPath('command.status', 'accepted');
        $this->postJson('/operasi/qa', $body)->assertCreated();
        $this->assertSame(1, OperationQaDecision::count());
        Http::assertSentCount(1);
        Http::assertSent(fn ($r) => str_ends_with($r->url(), '/qa') && str_starts_with($r['actor'], 'QA/Lab:') && $r['disposition'] === 'return_supplier');
        $this->assertSame($body, OperationQaDecision::sole()->request);
        $this->postJson('/operasi/qa', [...$body, 'reason' => 'Alasan yang berbeda'])->assertUnprocessable();
    }

    public function test_only_qa_or_admin_can_decide_not_ppic_or_observer(): void
    {
        $this->fakeQa();
        foreach ([Role::Ppic, Role::Observer, Role::Operator, Role::Driver] as $role) {
            $this->actingAs(User::factory()->role($role)->create());
            $this->postJson('/operasi/qa', $this->body())->assertForbidden();
        }
        $this->actingAs(User::factory()->role(Role::Admin)->create());
        $this->postJson('/operasi/qa', $this->body())->assertCreated();
    }

    public function test_confirmation_requires_only_ph_and_rejects_removed_parameters(): void
    {
        $this->fakeQa();
        $results = ['ph' => 6.7];
        $body = $this->body(['action' => 'retest', 'results' => $results]);
        unset($body['disposition']);
        $this->postJson('/operasi/qa', [...$body, 'results' => []])->assertUnprocessable();
        foreach (['fat_pct', 'protein_pct', 'acidity_pct', 'antibiotic_residue', 'adulterant'] as $removed) {
            $this->postJson('/operasi/qa', [...$body, 'results' => [...$results, $removed => 0]])->assertUnprocessable();
        }
        foreach ([-1, 15, true, 'invalid'] as $invalid) {
            $this->postJson('/operasi/qa', [...$body, 'results' => ['ph' => $invalid]])->assertUnprocessable();
        }
        $this->postJson('/operasi/qa', $body)->assertCreated();
        $missing = $this->body();
        unset($missing['disposition']);
        $this->postJson('/operasi/qa', $missing)->assertUnprocessable();
    }

    public function test_engine_rejection_and_uncertain_retry_never_report_success(): void
    {
        Http::swap(new Factory);
        Http::fake(['engine.test/*/qa' => Http::sequence()->push(['detail' => 'Engine belum siap'], 503)->push(['detail' => 'Override QA dilarang'], 409)]);
        $body = $this->body();
        $this->postJson('/operasi/qa', $body)->assertUnprocessable()->assertJsonPath('errors.engine.0', 'Engine belum siap');
        $this->assertSame('uncertain', OperationQaDecision::sole()->status);
        $this->postJson('/operasi/qa', $body)->assertUnprocessable()->assertJsonPath('errors.engine.0', 'Override QA dilarang');
        $this->assertSame('rejected', OperationQaDecision::sole()->status);
        $this->postJson('/operasi/qa', $body)->assertUnprocessable();
        Http::assertSentCount(2);
    }

    public function test_finished_and_non_live_runs_cannot_be_changed(): void
    {
        $this->fakeQa();
        $run = SimRun::sole();
        $run->update(['status' => 'finished']);
        $this->postJson('/operasi/qa', $this->body())->assertUnprocessable();
        $run->update(['status' => 'running', 'config_snapshot' => ['live' => false]]);
        $this->postJson('/operasi/qa', $this->body())->assertUnprocessable();
        Http::assertNothingSent();
    }

    public function test_qa_history_is_validated_and_persisted_with_finished_result(): void
    {
        $run = SimRun::sole();
        $result = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
        $result['run_id'] = $run->id;
        $last = end($result['events']);
        $code = $result['tankers'][0]['code'];
        $result['events'][] = [
            'event_id' => (string) Str::uuid(), 'run_id' => $run->id, 'seq' => $last['seq'] + 1,
            'sim_time' => $last['sim_time'],
            'payload' => [
                'type' => 'qa.review', 'tanker_code' => $code, 'status' => 'rejected', 'reason' => 'Hasil konfirmasi tidak memenuhi batas',
                'actor' => 'QA: Analis', 'request_id' => (string) Str::uuid(), 'results' => null,
                'failures' => [['parameter' => 'ph', 'value' => 5.0, 'minimum' => 6.6, 'maximum' => 6.8, 'reason' => 'Di luar spesifikasi']],
                'category' => 'quality', 'disposition' => 'return_supplier', 'expires_min' => 1440,
            ],
        ];
        $this->postJson("/internal/runs/{$run->id}/result", $result, ['X-Internal-Token' => 'secret'])->assertOk();
        $this->assertDatabaseHas('sim_events', ['run_id' => $run->id, 'type' => 'qa.review']);
        $this->getJson("/runs/{$run->id}/replay")->assertOk()
            ->assertJsonFragment(['type' => 'qa.review', 'tanker_code' => $code, 'status' => 'rejected']);
    }
}
