<?php

namespace App\Http\Controllers;

use App\Events\TwinEventBroadcast;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

class TwinEventController extends Controller
{
    public function store(Request $request): Response
    {
        $request->validate([
            'events' => ['required', 'array', 'max:500'],
            'events.*.event_id' => ['required', 'uuid'],
            'events.*.run_id' => ['required', 'integer', 'min:1'],
            'events.*.seq' => ['required', 'integer', 'min:0'],
            'events.*.sim_time' => ['required', 'date'],
            'events.*.payload' => ['required', 'array'],
            'events.*.payload.type' => ['required', 'string'],
        ]);

        foreach ($request->input('events') as $event) {
            TwinEventBroadcast::dispatch($event);
        }

        return response()->noContent();
    }
}
