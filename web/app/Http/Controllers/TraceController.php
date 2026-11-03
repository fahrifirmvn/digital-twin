<?php

namespace App\Http\Controllers;

use App\Services\TraceService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TraceController extends Controller
{
    public function index(Request $request, TraceService $service)
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

        // Contoh kode untuk run terpilih, supaya pengguna tahu apa yang bisa dicari.
        $examples = $runId > 0
            ? DB::table('batches')->where('run_id', $runId)->where('type', 'fg')->orderBy('code')->limit(5)->pluck('code')
            : collect();

        return view('trace', compact('runs', 'runId', 'code', 'trace', 'notFound', 'examples'));
    }
}
