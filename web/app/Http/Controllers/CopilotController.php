<?php

namespace App\Http\Controllers;

use App\Services\AuditLogger;
use App\Services\EngineClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

// Copilot hanya perantara: peran diambil dari sesi, jawaban dan semua panggilan alat dicatat ke
// audit log. Perubahan keadaan tidak pernah terjadi di sini (usulan dieksekusi lewat rute biasa
// yang memiliki Gate sendiri).
class CopilotController extends Controller
{
    private const FALLBACK = 'Copilot sedang tidak tersedia. Gunakan Panel Skenario untuk menjalankan atau membandingkan skenario.';

    public function chat(Request $request, EngineClient $engine, AuditLogger $audit): JsonResponse
    {
        $data = $request->validate([
            'message' => ['required', 'string', 'max:1000'],
            'run_id' => ['nullable', 'integer', 'min:1', 'exists:sim_runs,id'],
            'history' => ['sometimes', 'array', 'max:20'],
            'history.*.role' => ['required', 'in:user,assistant'],
            'history.*.content' => ['required', 'string', 'max:2000'],
        ]);
        $user = $request->user();

        try {
            $reply = $engine->copilotChat([
                'role' => $user->role->value,
                'message' => $data['message'],
                'run_id' => $data['run_id'] ?? null,
                'history' => array_values($data['history'] ?? []),
            ]);
        } catch (RuntimeException $e) {
            $reply = ['status' => 'unavailable', 'text' => self::FALLBACK];
        }

        $reply += ['sources' => [], 'proposals' => [], 'tool_trace' => [], 'provider' => '', 'model' => ''];
        $audit->record('user', (string) $user->id, 'copilot.chat', [
            'run_id' => $data['run_id'] ?? null,
            'message' => $data['message'],
            'status' => $reply['status'],
            'reply' => $reply['text'],
            'provider' => $reply['provider'],
            'model' => $reply['model'],
            'tool_calls' => collect($reply['tool_trace'])->map(fn ($t) => [
                'name' => $t['name'] ?? null,
                'args' => $t['args'] ?? null,
                'ok' => $t['ok'] ?? false,
                'denied' => $t['denied'] ?? false,
            ])->all(),
            'proposals' => $reply['proposals'],
        ]);

        return response()->json([
            'status' => $reply['status'],
            'text' => $reply['text'],
            'sources' => collect($reply['sources'])->map(fn ($s) => $this->source($s))->filter()->values(),
            'proposals' => $this->proposals($reply['proposals'], $request),
        ]);
    }

    /** @param array<string, mixed> $s */
    private function source(array $s): ?array
    {
        $runId = (int) ($s['run_id'] ?? 0);
        if ($runId < 1) {
            return null;
        }
        $code = $s['code'] ?? null;
        $label = $code ? "{$s['tool']} · run #{$runId} · {$code}" : "{$s['tool']} · run #{$runId}";
        $traceable = ($s['tool'] ?? '') === 'trace_batch' && $code && auth()->user()->can('view-trace');
        $url = $traceable ? route('trace', ['run' => $runId, 'code' => $code]) : route('runs.show', $runId);

        return ['label' => $label, 'url' => $url];
    }

    /**
     * Hanya usulan yang boleh dieksekusi pengguna ini yang diteruskan ke UI (defense in depth).
     *
     * @param  list<array<string, mixed>>  $proposals
     */
    private function proposals(array $proposals, Request $request): array
    {
        $user = $request->user();

        return collect($proposals)->filter(fn ($p) => match ($p['kind'] ?? null) {
            'run' => $user->can('run-scenario'),
            'approve_plan' => $user->can('approve-schedule'),
            default => false,
        })->values()->all();
    }
}
