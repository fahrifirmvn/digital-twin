<?php

namespace App\Http\Controllers;

use App\Services\AuditLogger;
use App\Services\FieldTasks;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;

// Driver PWA dan Operator View (PRD 4, P1). Klien offline-first: konfirmasi diantrikan di perangkat
// dan dikirim batch; uuid dari perangkat membuat kirim ulang aman.
class FieldController extends Controller
{
    public function page(Request $request, string $mode)
    {
        return view('field', ['mode' => $mode]);
    }

    public function manifest(Request $request, FieldTasks $tasks): JsonResponse
    {
        $run = DB::table('sim_runs')->where('status', 'finished')->orderByDesc('id')->first(['id', 'sim_start', 'sim_end']);
        if ($run === null) {
            return response()->json(['run' => null, 'trucks' => [], 'tasks' => [], 'confirmed' => []]);
        }

        // Sopir hanya melihat kode, asal, dan ETA: tanpa volume, suhu, atau hasil mutu (PRD 4).
        $trucks = DB::table('tankers')->join('farms', 'farms.id', '=', 'tankers.farm_id')
            ->where('tankers.run_id', $run->id)->orderBy('tankers.eta_p50')->orderBy('tankers.code')
            ->get(['tankers.code', 'farms.code as farm_code', 'tankers.eta_p50 as eta']);

        return response()->json([
            'run' => ['id' => $run->id, 'sim_start' => $run->sim_start, 'sim_end' => $run->sim_end],
            'trucks' => $trucks,
            'tasks' => $request->user()->can('confirm-handoff') ? $tasks->forRun($run->id) : [],
            'confirmed' => DB::table('field_confirmations')->where('run_id', $run->id)
                ->get(['kind', 'subject'])->map(fn ($c) => "{$c->kind}|{$c->subject}")->all(),
        ]);
    }

    public function store(Request $request, FieldTasks $tasks, AuditLogger $audit): JsonResponse
    {
        $data = $request->validate([
            'items' => ['required', 'array', 'min:1', 'max:50'],
            'items.*.uuid' => ['required', 'uuid'],
            'items.*.run_id' => ['required', 'integer', 'min:1'],
            'items.*.kind' => ['required', Rule::in(['check_in', 'handoff'])],
            'items.*.subject' => ['required', 'string', 'max:60'],
            'items.*.client_at' => ['required', 'date'],
        ]);
        $user = $request->user();

        $results = [];
        foreach ($data['items'] as $item) {
            $results[$item['uuid']] = $this->record($item, $user, $tasks, $audit);
        }

        return response()->json(['results' => $results]);
    }

    /** @return 'recorded'|'duplicate'|'forbidden'|'rejected' */
    private function record(array $item, $user, FieldTasks $tasks, AuditLogger $audit): string
    {
        if ($item['kind'] === 'handoff' && Gate::forUser($user)->denies('confirm-handoff')) {
            return 'forbidden';
        }
        $finished = DB::table('sim_runs')->where('id', $item['run_id'])->where('status', 'finished')->exists();
        $known = $finished && ($item['kind'] === 'check_in'
            ? DB::table('tankers')->where('run_id', $item['run_id'])->where('code', $item['subject'])->exists()
            : in_array($item['subject'], array_column($tasks->forRun($item['run_id']), 'key'), true));
        if (! $known) {
            return 'rejected';
        }

        $inserted = DB::table('field_confirmations')->insertOrIgnore([
            'uuid' => $item['uuid'], 'run_id' => $item['run_id'], 'kind' => $item['kind'],
            'subject' => $item['subject'], 'user_id' => $user->id,
            'client_at' => $item['client_at'], 'created_at' => now(),
        ]);
        if ($inserted === 0) {
            return 'duplicate';
        }

        $audit->record('user', (string) $user->id, $item['kind'] === 'check_in' ? 'truck.checked_in' : 'task.handoff_confirmed', [
            'run_id' => $item['run_id'], 'subject' => $item['subject'], 'client_at' => $item['client_at'],
        ]);

        return 'recorded';
    }
}
