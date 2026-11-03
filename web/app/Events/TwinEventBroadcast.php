<?php

namespace App\Events;

use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Foundation\Events\Dispatchable;

class TwinEventBroadcast implements ShouldBroadcastNow
{
    use Dispatchable, InteractsWithSockets;

    /** @param array<string, mixed> $event Amplop TwinEvent dari Engine (contracts/twin-event.schema.json). */
    public function __construct(public array $event) {}

    public function broadcastOn(): PrivateChannel
    {
        return new PrivateChannel('twin.'.$this->event['run_id']);
    }

    public function broadcastAs(): string
    {
        return 'twin.event';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return $this->event;
    }
}
