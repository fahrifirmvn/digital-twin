<?php

namespace App\Http\Controllers;

use App\Services\EngineClient;
use App\Services\LiveMaintenanceService;
use App\Services\LiveQaService;
use App\Services\OperationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use RuntimeException;

// Operasi harian: status, riwayat hari yang sudah lewat (untuk putar ulang), dan maju ke hari berikutnya.
class OperationController extends Controller
{
    public function qa(Request $request, LiveQaService $qa): JsonResponse
    {
        $data = $request->validate([
            'request_id' => ['required', 'uuid'], 'run_id' => ['required', 'integer', 'min:1'],
            'truck' => ['required', 'regex:/^[A-Z]{2}-\d{3,}$/'],
            'action' => ['required', Rule::in(['retest', 'release', 'reject'])],
            'reason' => ['required', 'string', 'min:5', 'max:200'],
            'disposition' => ['required_if:action,reject', 'prohibited_unless:action,reject', Rule::in(['return_supplier', 'controlled_disposal'])],
            'results' => ['required_if:action,retest', 'prohibited_unless:action,retest', 'array:ph'],
            'results.ph' => ['required_with:results', 'numeric', 'between:0,14'],
        ]);

        return response()->json(['command' => $qa->apply($request->user(), $data)], 201);
    }

    public function state(OperationService $op): JsonResponse
    {
        return response()->json($op->state());
    }

    public function advance(Request $request, OperationService $op): JsonResponse
    {
        return response()->json($op->advance($request->user()));
    }

    public function maintenance(Request $request, LiveMaintenanceService $maintenance, OperationService $op): JsonResponse
    {
        [$min, $max] = config('twin.campaign.maintenance_minutes');
        $data = $request->validate([
            'request_id' => ['required', 'uuid'], 'run_id' => ['required', 'integer', 'min:1'],
            'asset' => ['required', 'regex:/^TK-(RAW|STO)-\d{1,2}$/'],
            'mode' => ['required', Rule::in(['now', 'scheduled'])],
            'day' => ['required_if:mode,scheduled', 'nullable', 'integer', 'min:1', 'max:'.config('twin.campaign.max_days')],
            'start_min' => ['required_if:mode,scheduled', 'nullable', 'numeric', 'min:0', 'lt:1440'],
            'duration_min' => ['required', 'numeric', "min:$min", "max:$max"],
            'reason' => ['required', 'string', 'min:5', 'max:200'],
        ]);
        $entry = $maintenance->apply($request->user(), $data);

        return response()->json($op->state() + ['command' => $entry], 201);
    }

    public function speed(Request $request, OperationService $op, EngineClient $engine): JsonResponse
    {
        $data = $request->validate(['run_id' => ['required', 'integer'], 'speed' => ['required', Rule::in([1, 5, 20, 60])]]);
        $active = $op->current()?->days()->where('status', 'running')->first();
        if (! $active || $active->run_id !== $data['run_id']) {
            throw ValidationException::withMessages(['run_id' => 'Kecepatan hanya dapat diubah pada hari aktif.']);
        }
        try {
            return response()->json($engine->liveCommand($active->run_id, 'speed', ['speed' => (int) $data['speed']]));
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages(['engine' => $e->getMessage()]);
        }
    }
}
