<?php

namespace App\Http\Controllers;

use App\Models\Campaign;
use App\Models\SimRun;
use App\Services\AuditLogger;
use App\Services\EngineClient;
use App\Services\ProposalService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use RuntimeException;

// Operator Agent: Laravel menentukan siapa penggunanya dan apa perannya, Engine menjalankan LLM dan alat baca.
class AgentController extends Controller
{
    private const FALLBACK = 'Asisten AI sedang tidak tersedia. Gunakan Panel Skenario untuk menjalankan atau membandingkan skenario.';

    public function turn(Request $request, EngineClient $engine, AuditLogger $audit, ProposalService $proposals): JsonResponse
    {
        $data = $request->validate([
            'message' => ['required', 'string', 'min:1', 'max:1000'],
            'conversation_id' => ['nullable', 'uuid'],
            'run_id' => ['nullable', 'integer', 'min:1'],
            'campaign_id' => ['nullable', 'integer', 'exists:campaigns,id'],
            'history' => ['sometimes', 'array', 'max:20'],
            'history.*.role' => ['required', 'in:user,assistant'],
            'history.*.content' => ['required', 'string', 'max:2000'],
            'ui_context' => ['sometimes', 'array'],
            'ui_context.selected_code' => ['sometimes', 'nullable', 'string', 'max:32', 'regex:/^[A-Za-z0-9:_-]{2,32}$/'],
            'ui_context.minute' => ['sometimes', 'nullable', 'integer', 'min:0', 'max:2880'],
            'ui_context.view' => ['sometimes', 'nullable', 'string', 'in:recv,process'],
        ]);
        $user = $request->user();
        $run = isset($data['run_id']) ? SimRun::find($data['run_id']) : null;
        $campaign = isset($data['campaign_id']) ? Campaign::find($data['campaign_id']) : null;
        // Kampanye selalu SIMULASI; run LIVE tidak dicampur dengan usulan kampanye.
        $mode = ! $campaign && $run?->modeBadge()['key'] === 'live' ? 'LIVE' : 'SIMULASI';
        $run = $campaign && $run?->modeBadge()['key'] === 'live' ? null : $run;
        $conversation = $data['conversation_id'] ?? (string) Str::uuid();

        $payload = [
            'conversation_id' => $conversation, 'user_id' => $user->id, 'role' => $user->role->value, 'mode' => $mode,
            'message' => $data['message'], 'run_id' => $run?->id, 'history' => $data['history'] ?? [],
            'campaign' => $campaign ? $proposals->context($campaign, $user) : null,
        ];
        if (! empty($data['ui_context'])) {
            $payload['ui_context'] = array_filter($data['ui_context'], fn ($v) => $v !== null && $v !== '');
        }

        try {
            $reply = $engine->agentTurn($payload);
        } catch (RuntimeException $e) {
            Log::warning('Engine agent tidak terjangkau', ['pesan' => $e->getMessage()]);
            $reply = ['status' => 'unavailable', 'text' => self::FALLBACK, 'mode' => $mode, 'label' => "DATA SINTETIS | mode {$mode}",
                'error' => ['code' => 'engine_unreachable', 'message' => self::FALLBACK], 'sources' => [], 'audit' => []];
        }

        $saved = $campaign && ($reply['status'] ?? '') === 'ok' && ! empty($reply['proposals'])
            ? $proposals->persistDrafts($campaign, $user, $conversation, $reply, $reply['proposals']) : [];
        $ids = collect($saved)->pluck('uuid')->all();
        $reply['audit'] = array_map(fn ($e) => ['proposal_id' => in_array($e['proposal_id'] ?? null, $ids, true) ? $e['proposal_id'] : null] + $e, $reply['audit'] ?? []);
        $requestedExports = collect(($reply['status'] ?? '') === 'ok' ? ($reply['exports'] ?? []) : [])->filter(fn ($e) => is_array($e)
            && (int) ($e['run_id'] ?? 0) > 0
            && in_array($e['format'] ?? '', ['csv', 'pdf', 'docx'], true)
        )->unique(fn ($e) => $e['run_id'].'|'.$e['format'])->values();
        $exportRuns = SimRun::query()->whereIn('id', $requestedExports->pluck('run_id')->map(fn ($id) => (int) $id))
            ->where('status', 'finished')->whereNotNull('result_payload')->pluck('id')->map(fn ($id) => (int) $id)->all();
        $reply['exports'] = $requestedExports->filter(fn ($e) => in_array((int) $e['run_id'], $exportRuns, true))->map(fn ($e) => [
            'run_id' => (int) $e['run_id'],
            'format' => $e['format'],
            'url' => route('runs.report', ['run' => $e['run_id'], 'format' => $e['format']]),
        ])->values()->all();

        $this->record($audit, $user->id, $user->role->value, $mode, $conversation, $data['message'], $reply);

        return response()->json(['conversation_id' => $conversation] + Arr::only($reply, [
            'status', 'text', 'mode', 'label', 'error', 'sources', 'provider', 'model', 'model_version',
        ]) + ['proposals' => array_map(fn ($p) => $p->summary(), $saved), 'exports' => $reply['exports'], 'tools' => array_map(fn ($e) => ['tool' => $e['tool'] ?? '', 'ok' => (bool) ($e['ok'] ?? false), 'ms' => (int) ($e['ms'] ?? 0)], $reply['audit'] ?? [])]);
    }

    /** Peran, pengguna, dan percakapan diambil dari sesi, bukan dari balasan Engine (P7). */
    private function record(AuditLogger $audit, int $userId, string $role, string $mode, string $conversation, string $message, array $reply): void
    {
        $audit->record('user', (string) $userId, 'agent.turn', [
            'conversation_id' => $conversation, 'role' => $role, 'mode' => $mode, 'message' => Str::limit($message, 500, ''),
            'status' => $reply['status'] ?? 'error', 'error' => $reply['error']['code'] ?? null,
            'model' => $reply['model'] ?? null, 'model_version' => $reply['model_version'] ?? null,
            'input_tokens' => (int) ($reply['input_tokens'] ?? 0), 'output_tokens' => (int) ($reply['output_tokens'] ?? 0),
        ]);
        foreach (array_slice($reply['audit'] ?? [], 0, 40) as $e) {
            $audit->record('user', (string) $userId, 'agent.tool_call', [
                'conversation_id' => $conversation, 'user_id' => $userId, 'role' => $role, 'mode' => $mode,
                'model_name' => $e['model_name'] ?? null, 'model_version' => $e['model_version'] ?? null,
                'tool' => $e['tool'] ?? '', 'args' => $e['args'] ?? [], 'result_hash' => $e['result_hash'] ?? '',
                'ok' => (bool) ($e['ok'] ?? false), 'error' => $e['error'] ?? null, 'step' => $e['step'] ?? null,
                'proposal_id' => $e['proposal_id'] ?? null, 'at' => $e['at'] ?? now()->toIso8601String(),
            ]);
        }
    }
}
