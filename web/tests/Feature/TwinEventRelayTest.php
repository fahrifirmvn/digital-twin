<?php

namespace Tests\Feature;

use App\Events\TwinEventBroadcast;
use Illuminate\Support\Facades\Event;
use Tests\TestCase;

class TwinEventRelayTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.token' => 'secret']);
    }

    private function event(int $seq = 0): array
    {
        return [
            'event_id' => '6f1c4f9e-6a53-5d1e-9a3f-0d8e5b6a7c10',
            'run_id' => 7,
            'seq' => $seq,
            'sim_time' => '2026-10-28T06:00:00Z',
            'payload' => ['type' => 'sim.clock', 'speed' => 1, 'paused' => false],
        ];
    }

    public function test_requires_valid_token(): void
    {
        Event::fake();
        $body = ['events' => [$this->event()]];

        $this->postJson('/internal/twin-events', $body)->assertUnauthorized();
        $this->postJson('/internal/twin-events', $body, ['X-Internal-Token' => 'wrong'])->assertUnauthorized();
        Event::assertNotDispatched(TwinEventBroadcast::class);
    }

    public function test_unconfigured_token_rejects_everything(): void
    {
        config(['services.engine.token' => '']);

        $this->postJson('/internal/twin-events', ['events' => [$this->event()]], ['X-Internal-Token' => ''])
            ->assertUnauthorized();
    }

    public function test_broadcasts_each_event_on_private_run_channel(): void
    {
        Event::fake();

        $this->postJson('/internal/twin-events', ['events' => [$this->event(0), $this->event(1)]], ['X-Internal-Token' => 'secret'])
            ->assertNoContent();

        Event::assertDispatchedTimes(TwinEventBroadcast::class, 2);
        Event::assertDispatched(TwinEventBroadcast::class, function (TwinEventBroadcast $e) {
            return $e->broadcastOn()->name === 'private-twin.7'
                && $e->broadcastAs() === 'twin.event'
                && $e->broadcastWith()['payload']['type'] === 'sim.clock';
        });
    }

    public function test_rejects_malformed_events(): void
    {
        Event::fake();
        $bad = $this->event();
        unset($bad['payload']['type']);

        $this->postJson('/internal/twin-events', ['events' => [$bad]], ['X-Internal-Token' => 'secret'])
            ->assertUnprocessable();
        $this->postJson('/internal/twin-events', ['events' => []], ['X-Internal-Token' => 'secret'])
            ->assertUnprocessable();
        Event::assertNotDispatched(TwinEventBroadcast::class);
    }
}
