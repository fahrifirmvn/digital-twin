<?php

namespace App\Services;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use RuntimeException;

// Satu-satunya jalur Laravel memanggil Engine.
class EngineClient
{
    /** @param array{seed:int, volume_ton:float|int, extra_bad:int, speed?:float|int|null, plant?:array<string,int>, commands?:list<array<string,mixed>>} $params */
    public function startRun(int $runId, array $params): void
    {
        try {
            $res = Http::baseUrl(config('services.engine.url'))
                ->withHeaders(['X-Internal-Token' => (string) config('services.engine.token')])
                ->timeout(10)
                ->acceptJson()
                ->post('/v1/runs', ['run_id' => $runId] + $params);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Engine tidak dapat dihubungi', previous: $e);
        }

        if (! $res->successful()) {
            throw new RuntimeException("Engine menolak run (HTTP {$res->status()})");
        }
    }

    /**
     * Peran dikirim dari sesi server, bukan dari browser. Timeout longgar karena menunggu LLM.
     *
     * @param  array{role:string, message:string, run_id:int|null, history:list<array{role:string, content:string}>}  $payload
     * @return array<string, mixed>
     */
    public function copilotChat(array $payload): array
    {
        try {
            $res = Http::baseUrl(config('services.engine.url'))
                ->withHeaders(['X-Internal-Token' => (string) config('services.engine.token')])
                ->timeout((int) config('twin.copilot_timeout', 90))
                ->acceptJson()
                ->post('/v1/copilot/chat', $payload);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Engine tidak dapat dihubungi', previous: $e);
        }
        if (! $res->successful() || ! is_array($res->json())) {
            throw new RuntimeException("Copilot Engine gagal (HTTP {$res->status()})");
        }

        return $res->json();
    }
}
