<?php

namespace App\Http\Controllers;

use App\Services\TraceService;
use App\Services\VolumeBalance;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TraceController extends Controller
{
    public function index(Request $request, TraceService $service, VolumeBalance $volumeBalance)
    {
        $data = $request->validate([
            'run' => ['nullable', 'integer', 'min:1'],
            'code' => ['nullable', 'string', 'max:40', 'regex:/^[A-Za-z0-9._-]+$/'],
        ]);

        $runs = DB::table('sim_runs')->where('status', 'finished')->orderByDesc('id')->limit(20)->pluck('id');
        $runId = (int) ($data['run'] ?? $runs->first() ?? 0);
        $code = isset($data['code']) ? strtoupper($data['code']) : null;

        $trace = null;
        $notFound = false;
        if ($code !== null && $runId > 0) {
            $trace = $service->trace($runId, $code);
            $notFound = $trace === null;
        }

        // Contoh kode untuk run terpilih, supaya pengguna tahu apa yang bisa dicari (backward & forward).
        $examples = $runId > 0
            ? DB::table('batches')->where('run_id', $runId)->where('type', 'fg')->orderBy('code')->limit(5)->pluck('code')
            : collect();

        $mixedExamples = $runId > 0
            ? DB::table('batches')
                ->join('batch_lineage', 'batch_lineage.child_batch_id', '=', 'batches.id')
                ->where('batches.run_id', $runId)
                ->where('batches.type', 'fg')
                ->groupBy('batches.id', 'batches.code')
                ->havingRaw('COUNT(batch_lineage.parent_batch_id) > 1')
                ->orderBy('batches.code')
                ->limit(4)
                ->pluck('batches.code')
            : collect();

        $splitExamples = $runId > 0
            ? DB::table('batches')
                ->join('batch_lineage', 'batch_lineage.parent_batch_id', '=', 'batches.id')
                ->where('batches.run_id', $runId)
                ->where('batches.type', 'intermediate')
                ->groupBy('batches.id', 'batches.code')
                ->havingRaw('COUNT(batch_lineage.child_batch_id) > 1')
                ->orderBy('batches.code')
                ->limit(4)
                ->pluck('batches.code')
            : collect();

        $tankerExamples = $runId > 0
            ? DB::table('tankers')
                ->join('batches', 'batches.tanker_id', '=', 'tankers.id')
                ->where('tankers.run_id', $runId)
                ->where('batches.type', 'raw')
                ->orderBy('tankers.code')
                ->limit(5)
                ->pluck('tankers.code')
            : collect();

        $balance = $runId > 0 ? $volumeBalance->forRun($runId) : null;

        return view('trace', compact(
            'runs',
            'runId',
            'code',
            'trace',
            'notFound',
            'examples',
            'mixedExamples',
            'splitExamples',
            'tankerExamples',
            'balance',
        ));
    }
}
