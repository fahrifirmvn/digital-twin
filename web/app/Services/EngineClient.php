<?php

namespace App\Services;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use RuntimeException;

// Satu-satunya jalur Laravel memanggil Engine.
class EngineClient
{
    public function live(int $runId, int $after = -1): array
    {
        return $this->liveRequest('GET', "/v1/runs/{$runId}/live", ['after' => $after]);
    }

    public function liveCommand(int $runId, string $kind, array $payload): array
    {
        return $this->liveRequest('POST', "/v1/runs/{$runId}/{$kind}", $payload);
    }

    private function liveRequest(string $method, string $url, array $payload): array
    {
        try {
            $client = Http::baseUrl(config('services.engine.url'))
                ->withHeaders(['X-Internal-Token' => (string) config('services.engine.token')])
                ->timeout(10)->acceptJson();
            $res = $method === 'GET' ? $client->get($url, $payload) : $client->post($url, $payload);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Engine live tidak dapat dihubungi. Coba ulang perintah dengan ID yang sama.', previous: $e);
        }
        if (! $res->successful() || ! is_array($res->json())) {
            throw new RuntimeException((string) ($res->json('detail') ?? "Engine live menolak permintaan (HTTP {$res->status()})."), $res->status());
        }

        return $res->json();
    }

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
     * Satu giliran Operator Agent. Identitas dan peran berasal dari sesi Laravel, bukan dari klien.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public function agentTurn(array $payload): array
    {
        try {
            $res = Http::baseUrl(config('services.engine.url'))
                ->withHeaders(['X-Internal-Token' => (string) config('services.engine.token')])
                ->timeout((int) config('twin.agent.timeout'))
                ->acceptJson()
                ->post('/v1/agent/turn', $payload);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Engine tidak dapat dihubungi', previous: $e);
        }

        if (! $res->successful() || ! is_array($res->json())) {
            throw new RuntimeException("Engine menolak giliran agen (HTTP {$res->status()})");
        }

        return $res->json();
    }
}
