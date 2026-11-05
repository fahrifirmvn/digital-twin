<?php

namespace App\Http\Controllers;

use App\Models\SimRun;
use App\Services\CampaignService;
use App\Services\RunResultStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

// Endpoint internal: Engine mengirim hasil akhir run (kontrak: contracts/run-result.schema.json).
class RunResultController extends Controller
{
    public function show(SimRun $run): JsonResponse
    {
        abort_unless($run->status === 'finished' && $run->result_payload, 404);

        return response()->json($run->result_payload);
    }

    public function store(Request $request, SimRun $run, RunResultStore $store, CampaignService $campaigns): JsonResponse
    {
        // Idempoten: Engine mengulang kiriman bila respons hilang.
        if (in_array($run->status, ['finished', 'failed'], true)) {
            return response()->json(['status' => 'already_recorded']);
        }

        $status = $request->validate(['status' => ['required', Rule::in(['finished', 'failed'])]])['status'];

        if ($status === 'failed') {
            $data = $request->validate(['run_id' => ['required', 'integer', Rule::in([$run->id])], 'error' => ['required', 'string']]);
            $store->storeFailed($run, $data['error']);
            $campaigns->onRunFailed($run, $data['error']);

            return response()->json(['status' => 'recorded']);
        }

        $r = $request->validate([
            'run_id' => ['required', 'integer', Rule::in([$run->id])],
            'seed' => ['required', 'integer'],
            'config' => ['required', Rule::in(array_keys(config('twin.configs')))],
            'scenario' => ['sometimes', Rule::in(array_keys(config('twin.scenarios')))],
            'params' => ['required', 'array'],
            'sim_start' => ['required', 'date'],
            'sim_end' => ['required', 'date'],
            'kpi' => ['required', 'array'],
            'kpi.false_accept' => ['required', 'integer'],
            'tankers' => ['present', 'array', 'max:2000'],
            'tankers.*.code' => ['required', 'string', 'max:30'],
            'tankers.*.farm_code' => ['required', 'string', Rule::exists('farms', 'code')],
            'tankers.*.volume_ton' => ['required', 'numeric'],
            'tankers.*.temp_c' => ['required', 'numeric'],
            'tankers.*.status' => ['required', 'string', 'max:20'],
            'tankers.*.outcome' => ['required', 'string', 'max:20'],
            'tankers.*.lab_start' => ['nullable', 'date'],
            'tankers.*.lab_end' => ['nullable', 'date'],
            'tankers.*.analyst' => ['nullable', 'string', 'max:255'],
            'tankers.*.lab_results' => ['present', 'array'],
            'tankers.*.eta_p50' => ['nullable', 'date'],
            'tankers.*.eta_p80' => ['nullable', 'date'],
            'tankers.*.eta_p90' => ['nullable', 'date'],
            'plan' => ['nullable', 'array'],
            'plan.config' => ['required_with:plan', Rule::in(['B', 'C', 'D'])],
            'plan.status' => ['required_with:plan', 'string', 'max:20'],
            'plan.objective' => ['nullable', 'numeric'],
            'plan.solve_seconds' => ['required_with:plan', 'numeric'],
            'plan.trucks' => ['required_with:plan', 'array', 'max:2000'],
            'plan.trucks.*.code' => ['required', 'string', 'max:30'],
            'replans' => ['sometimes', 'array', 'max:500'],
            'replans.*.version' => ['required', 'integer', 'min:2'],
            'replans.*.at' => ['required', 'date'],
            'replans.*.trigger' => ['required', 'string', 'max:40'],
            'replans.*.status' => ['required', 'string', 'max:20'],
            'replans.*.trucks' => ['required', 'integer', 'min:0'],
            'replans.*.objective' => ['nullable', 'numeric'],
            'replans.*.solve_seconds' => ['required', 'numeric'],
            'replans.*.plan' => ['nullable', 'array'],
            'replans.*.plan.trucks' => ['required_with:replans.*.plan', 'array', 'max:2000'],
            'monte_carlo' => ['nullable', 'array'],
            'monte_carlo.samples' => ['required_with:monte_carlo', 'integer', 'min:1'],
            'monte_carlo.chosen' => ['required_with:monte_carlo', 'string', 'max:20'],
            'monte_carlo.candidates' => ['required_with:monte_carlo', 'array', 'max:20'],
            'monte_carlo.kpi_predicted' => ['required_with:monte_carlo', 'array'],
            'ai' => ['nullable', 'array'],
            'ai.label' => ['required_with:ai', 'string', 'max:40'],
            'ai.models' => ['required_with:ai', 'array'],
            'ai.trucks' => ['required_with:ai', 'array', 'max:2000'],
            'ai.trucks.*.code' => ['required', 'string', 'max:30'],
            'ai.trucks.*.qc_release_prob' => ['required', 'numeric', 'between:0,1'],
            'ai.trucks.*.transit_p50_min' => ['required', 'numeric'],
            'ai.trucks.*.transit_p80_min' => ['required', 'numeric'],
            'ai.trucks.*.transit_p90_min' => ['required', 'numeric'],
            'ai.trucks.*.delay_p50_min' => ['required', 'numeric'],
            'ai.trucks.*.delay_p80_min' => ['required', 'numeric'],
            'ai.trucks.*.delay_p90_min' => ['required', 'numeric'],
            'ai.trucks.*.lab_p50_min' => ['required', 'numeric'],
            'ai.trucks.*.lab_p90_min' => ['required', 'numeric'],
            'ai.anomaly' => ['required_with:ai', 'array'],
            'ai.anomaly.risk_score' => ['required_with:ai.anomaly', 'numeric', 'between:0,1'],
            'ai.anomaly.flags' => ['sometimes', 'array'],
            'ai.anomaly.is_anomaly' => ['required_with:ai.anomaly', 'boolean'],
            'ai.anomaly.balance_residual_l' => ['required_with:ai.anomaly', 'numeric'],
            'ai.anomaly.batch_age_h' => ['required_with:ai.anomaly', 'numeric'],
            'ai.anomaly.flow_deviation_pct' => ['required_with:ai.anomaly', 'numeric'],
            'batches' => ['present', 'array', 'max:10000'],
            'batches.*.code' => ['required', 'string', 'max:40'],
            'batches.*.type' => ['required', Rule::in(['raw', 'intermediate', 'fg'])],
            'batches.*.volume_ton' => ['required', 'numeric'],
            'batches.*.parents' => ['present', 'array'],
            'batches.*.tanker_code' => ['nullable', 'string'],
            'batches.*.sku_code' => ['nullable', 'string', Rule::exists('skus', 'code')],
            'batches.*.status' => ['required', 'string', 'max:20'],
            'transfers' => ['present', 'array', 'max:50000'],
            'transfers.*.from_asset' => ['required', 'string', 'max:30'],
            'transfers.*.to_asset' => ['required', 'string', 'max:30'],
            'transfers.*.batch_code' => ['required', 'string'],
            'transfers.*.volume_ton' => ['required', 'numeric'],
            'transfers.*.occurred_at' => ['required', 'date'],
            'gates' => ['present', 'array', 'max:50000'],
            'gates.*.gate' => ['required', Rule::in(['G1', 'G2', 'G3', 'G4', 'G5', 'G6'])],
            'gates.*.object_type' => ['required', 'string', 'max:20'],
            'gates.*.object_id' => ['required', 'string', 'max:40'],
            'gates.*.decision' => ['required', Rule::in(['pass', 'hold'])],
            'gates.*.reason' => ['nullable', 'string'],
            'gates.*.decided_at' => ['required', 'date'],
            'cips' => ['present', 'array', 'max:10000'],
            'cips.*.asset_code' => ['required', 'string', 'max:30'],
            'cips.*.started_at' => ['required', 'date'],
            'cips.*.finished_at' => ['required', 'date'],
            'cips.*.is_scheduled' => ['required', 'boolean'],
            'events' => ['present', 'array', 'max:100000'],
            'events.*.seq' => ['required', 'integer', 'min:0'],
            'events.*.sim_time' => ['required', 'date'],
            'events.*.payload' => ['required', 'array'],
            'events.*.payload.type' => ['required', 'string', 'max:40'],
            'day' => ['nullable', 'integer', 'min:1'],
        ]);

        // validate() hanya mengembalikan kunci yang punya aturan; kpi dan payload harus utuh.
        $r['carry_out'] = $request->array('carry_out') ?: null;
        $r['day_summary'] = $request->array('day_summary') ?: null;
        $r['result_payload'] = $request->json()->all();
        $r['kpi'] = $request->array('kpi');
        $r['plan'] = $request->array('plan') ?: null;
        $r['replans'] = $request->array('replans');
        $r['monte_carlo'] = $request->array('monte_carlo') ?: null;
        $r['scenario'] = $r['scenario'] ?? 'normal';
        $r['events'] = array_map(
            fn ($e) => ['seq' => $e['seq'], 'sim_time' => $e['sim_time'], 'payload' => $e['payload']],
            $request->array('events'),
        );

        $this->assertReferences($r);
        $store->storeFinished($run, $r);
        $campaigns->onRunFinished($run);

        return response()->json(['status' => 'recorded']);
    }

    /** @param array<string, mixed> $r */
    private function assertReferences(array $r): void
    {
        $codes = array_flip(array_column($r['batches'], 'code'));
        $tankers = array_flip(array_column($r['tankers'], 'code'));
        $bad = [];

        foreach ($r['batches'] as $b) {
            foreach ($b['parents'] as $p) {
                isset($codes[$p]) || $bad[] = "parent {$p} tidak dikenal";
            }
            if ($b['tanker_code'] !== null && ! isset($tankers[$b['tanker_code']])) {
                $bad[] = "tanker {$b['tanker_code']} tidak dikenal";
            }
        }
        foreach ($r['transfers'] as $t) {
            isset($codes[$t['batch_code']]) || $bad[] = "batch {$t['batch_code']} pada transfer tidak dikenal";
        }

        if ($bad) {
            throw ValidationException::withMessages(['references' => array_slice(array_unique($bad), 0, 10)]);
        }
    }
}
