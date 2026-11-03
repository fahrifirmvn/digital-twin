<?php

namespace App\Http\Controllers;

use App\Models\SimRun;
use App\Services\AuditLogger;
use App\Services\DaySchedule;
use App\Services\EngineClient;
use App\Services\HoldingAlerts;
use App\Services\OperationService;
use App\Services\OrderFeasibility;
use App\Services\VolumeBalance;
use App\Services\WearReport;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use RuntimeException;

class RunController extends Controller
{
    /** Run yang ditampilkan: ?run= bila ada, selain itu hari operasi yang sedang ditonton. Run lama yang diarsipkan dan cabang simulasi tidak pernah jadi bawaan. */
    private function resolveRun(Request $request): ?SimRun
    {
        if ($request->filled('run')) {
            return SimRun::findOrFail($request->integer('run'));
        }

        if ($watched = app(OperationService::class)->watchRun()) {
            return $watched;
        }
        $real = SimRun::whereNotIn('kind', ['simulation', 'campaign'])->whereNull('archived_at');

        return (clone $real)->where('status', 'finished')->orderByDesc('id')->first() ?? $real->orderByDesc('id')->first();
    }

    public function home(Request $request, DaySchedule $schedule, HoldingAlerts $holding, OrderFeasibility $orders, VolumeBalance $balance, WearReport $wear)
    {
        // Sopir hanya melihat tampilan terbatas (PRD 4), tanpa data run.
        if ($request->user()->cannot('view-twin-full')) {
            return view('limited');
        }
        $run = $this->resolveRun($request);
        if (! $run) {
            return view('runs.none', ['active' => 'dashboard']);
        }
        $finished = $run->status === 'finished';
        $kpi = $finished ? json_decode(DB::table('scenarios')->where('id', $run->scenario_id)->value('kpi_result') ?? 'null', true) : null;

        return view('home', ['run' => $run, 'kpi' => $kpi, 'schedule' => $finished ? $schedule->forRun($run->id) : [], 'holding' => $finished ? $holding->forRun($run->id) : [], 'orders' => $finished ? $orders->forRun($run->id) : null, 'balance' => $finished ? $balance->forRun($run->id) : null, 'wear' => $finished ? $wear->forRun($run->id) : null]);
    }

    public function twinCurrent(Request $request)
    {
        $run = $this->resolveRun($request);

        return $run ? $this->twin($run) : view('runs.none', ['active' => 'twin']);
    }

    public function maps(Request $request)
    {
        $run = $this->resolveRun($request);

        return $run ? view('maps', ['run' => $run]) : view('runs.none', ['active' => 'maps']);
    }

    public function index(Request $request)
    {
        $runs = DB::table('sim_runs')
            ->leftJoin('scenarios', 'scenarios.id', '=', 'sim_runs.scenario_id')
            ->whereNull('sim_runs.archived_at')->orderByDesc('sim_runs.id')->limit(10)
            ->get(['sim_runs.id', 'sim_runs.status', 'sim_runs.kind', 'sim_runs.parent_run_id', 'sim_runs.fork_minute', 'sim_runs.seed', 'sim_runs.config_snapshot', 'sim_runs.created_at', 'scenarios.name', 'scenarios.kpi_result']);

        return view('runs.index', ['runs' => $runs->map(function ($r) {
            $r->kpi = $r->kpi_result ? json_decode($r->kpi_result, true) : null;
            $snap = json_decode($r->config_snapshot ?? 'null', true);
            $r->config = is_array($snap) ? ($snap['config'] ?? 'A') : 'A';
            $r->scenario = is_array($snap) ? ($snap['scenario'] ?? 'normal') : 'normal';

            return $r;
        })]);
    }

    /** Aturan validasi parameter operasional (config/twin.php params), dipakai store dan retest. */
    private function paramRules(): array
    {
        $rules = ['params' => ['sometimes', 'nullable', 'array']];
        foreach (config('twin.params.fields') as $key => $f) {
            $rules["params.$key"] = ['nullable', 'numeric', 'min:'.$f['min'], 'max:'.$f['max']];
        }
        $rules['params.sku_policy'] = ['nullable', 'in:'.implode(',', array_keys(config('twin.params.sku_policy.options')))];
        $o = config('twin.params.orders');
        $rules['params.orders'] = ['nullable', 'array', 'max:'.$o['max']];
        $rules['params.orders.*.sku'] = ['nullable', 'in:'.implode(',', array_keys($o['skus']))];
        $rules['params.orders.*.ton'] = ['nullable', 'numeric', 'min:'.$o['min_ton'], 'max:'.$o['max_ton']];
        $m = config('twin.params.maintenance');
        $rules['params.maintenance'] = ['nullable', 'array', 'max:'.$m['max']];
        $rules['params.maintenance.*.asset'] = ['nullable', 'regex:/^STE-[1-8]$/'];
        $rules['params.maintenance.*.start_clock'] = ['nullable', 'date_format:H:i'];
        $rules['params.maintenance.*.duration_min'] = ['nullable', 'numeric', 'min:'.$m['min_duration'], 'max:'.$m['max_duration']];

        return $rules;
    }

    /**
     * Parameter yang benar-benar menyimpang dari bawaan. Nilai bawaan tidak disimpan, supaya run lama dan baru
     * tanpa perubahan tetap sebanding. Gagal bila CIP min > max atau maintenance menyebut sterilizer yang tidak ada.
     *
     * @param  array<string,mixed>  $in
     * @param  array<string,int>  $plant
     * @return array<string,mixed>
     */
    private function cleanParams(array $in, array $plant): array
    {
        $out = [];
        foreach (config('twin.params.fields') as $key => $f) {
            $v = $in[$key] ?? null;
            if ($v !== null && $v !== '' && (float) $v !== (float) $f['default']) {
                $out[$key] = $f['step'] >= 1 ? (int) $v : (float) $v;
            }
        }
        $fields = config('twin.params.fields');
        $cipMin = $out['cip_min_minutes'] ?? $fields['cip_min_minutes']['default'];
        $cipMax = $out['cip_max_minutes'] ?? $fields['cip_max_minutes']['default'];
        if ($cipMin > $cipMax) {
            throw ValidationException::withMessages(['params.cip_min_minutes' => 'CIP minimum tidak boleh melebihi CIP maksimum.']);
        }
        $policy = $in['sku_policy'] ?? null;
        if ($policy !== null && $policy !== '' && $policy !== config('twin.params.sku_policy.default')) {
            $out['sku_policy'] = $policy;
        }
        $orders = [];
        foreach (array_values($in['orders'] ?? []) as $i => $row) {
            $sku = $row['sku'] ?? '';
            $ton = $row['ton'] ?? '';
            if ($sku === '' && $ton === '') {
                continue; // baris kosong pada formulir
            }
            if ($sku === '' || $ton === '') {
                throw ValidationException::withMessages(["params.orders.$i.sku" => 'Order: isi SKU dan jumlah ton.']);
            }
            $orders[] = ['sku' => $sku, 'ton' => (float) $ton];
        }
        if ($orders) {
            $out['orders'] = $orders;
        }
        $steCount = $plant['n_sterilizers'] ?? 5;
        $maint = [];
        foreach (array_values($in['maintenance'] ?? []) as $i => $row) {
            if (($row['asset'] ?? '') === '') {
                continue; // baris kosong pada formulir
            }
            if (($row['start_clock'] ?? '') === '' || ($row['duration_min'] ?? '') === '') {
                throw ValidationException::withMessages(["params.maintenance.$i.asset" => "Maintenance {$row['asset']}: isi jam mulai dan durasi."]);
            }
            if ((int) substr($row['asset'], 4) > $steCount) {
                throw ValidationException::withMessages(["params.maintenance.$i.asset" => "Sterilizer {$row['asset']} tidak ada pada pabrik ini ({$steCount} sterilizer)."]);
            }
            // Jam dinding (HH:MM) -> menit sejak awal hari operasi 06:00.
            [$hh, $mm] = array_map('intval', explode(':', $row['start_clock']));
            $maint[] = ['asset' => $row['asset'], 'start_min' => (float) ((($hh * 60 + $mm - 360) % 1440 + 1440) % 1440), 'duration_min' => (float) $row['duration_min']];
        }
        if ($maint) {
            $out['maintenance'] = $maint;
        }

        return $out;
    }

    /** Buat satu run live dan kirim ke engine. Melempar RuntimeException bila engine tidak menerima. */
    private function launch(Request $request, EngineClient $engine, AuditLogger $audit, array $data, string $config, string $scenario, string $via): SimRun
    {
        $run = SimRun::create([
            'kind' => 'live',
            'seed' => $data['seed'],
            'status' => 'pending',
            'requested_by' => $request->user()->id,
            'config_snapshot' => ['config' => $config, 'scenario' => $scenario, 'params' => $data],
        ]);
        $audit->record('user', (string) $request->user()->id, 'run.requested', ['run_id' => $run->id, 'config' => $config, 'scenario' => $scenario, 'via' => $via] + $data);

        try {
            $engine->startRun($run->id, $data + ['config' => $config, 'scenario' => $scenario]);
            // Engine bisa selesai sebelum respons ini kembali, jadi jangan menimpa status akhir.
            DB::table('sim_runs')->where('id', $run->id)->where('status', 'pending')->update(['status' => 'running']);
        } catch (RuntimeException $e) {
            $run->update(['status' => 'failed', 'error' => $e->getMessage()]);
            throw $e;
        }

        return $run;
    }

    public function store(Request $request, EngineClient $engine, AuditLogger $audit)
    {
        $plantRules = [];
        foreach (config('twin.plant.limits') as $field => [$min, $max]) {
            $plantRules["plant.$field"] = ['nullable', 'integer', "min:$min", "max:$max"];
        }
        $data = $request->validate([
            'seed' => ['required', 'integer', 'min:0', 'max:2147483647'],
            'volume_ton' => ['required', 'numeric', 'min:50', 'max:600'],
            'extra_bad' => ['required', 'integer', 'min:0', 'max:10'],
            'config' => ['sometimes', Rule::in(array_keys(config('twin.configs')))],
            'scenario' => ['sometimes', Rule::in(array_keys(config('twin.scenarios')))],
            'go' => ['sometimes', Rule::in(['twin'])],
            'plant' => ['sometimes', 'nullable', 'array'],
        ] + $plantRules + $this->paramRules());
        $config = $data['config'] ?? 'A';
        $scenario = $data['scenario'] ?? 'normal';
        $via = 'form';
        $go = $data['go'] ?? null;
        unset($data['config'], $data['scenario'], $data['go']);
        // Pabrik bawaan tidak disimpan, supaya run lama dan baru tanpa perubahan tetap sebanding.
        $plant = array_filter($data['plant'] ?? [], fn ($n) => $n !== null);
        unset($data['plant']);
        if ($plant) {
            $data['plant'] = array_map('intval', $plant);
        }
        $params = $this->cleanParams($data['params'] ?? [], $plant);
        unset($data['params']);
        if ($params) {
            $data['params'] = $params;
        }

        try {
            $run = $this->launch($request, $engine, $audit, $data, $config, $scenario, $via);
        } catch (RuntimeException $e) {
            return redirect()->route($go === 'twin' ? 'build' : 'runs.index')->withErrors(['engine' => $e->getMessage()]);
        }

        return redirect()->route($go === 'twin' ? 'runs.twin' : 'runs.show', $run->id);
    }

    /**
     * "Uji ulang": hari yang sama (seed, volume, skenario, pabrik) dengan parameter operasional baru, dijalankan
     * sebagai A (FIFO) dan B (CP-SAT). Hasilnya muncul di perbandingan What-if run B.
     */
    public function retest(SimRun $run, Request $request, EngineClient $engine, AuditLogger $audit)
    {
        $in = $request->validate($this->paramRules());
        $old = $run->config_snapshot['params'] ?? [];
        $data = array_intersect_key($old, array_flip(['seed', 'volume_ton', 'extra_bad', 'plant'])) + ['seed' => $run->seed];
        $params = $this->cleanParams($in['params'] ?? [], $data['plant'] ?? []);
        if ($params) {
            $data['params'] = $params;
        }
        $scenario = $run->config_snapshot['scenario'] ?? 'normal';

        try {
            $this->launch($request, $engine, $audit, $data, 'A', $scenario, 'retest');
            $b = $this->launch($request, $engine, $audit, $data, 'B', $scenario, 'retest');
        } catch (RuntimeException $e) {
            return redirect()->route('runs.show', $run)->withErrors(['engine' => $e->getMessage()]);
        }

        return redirect()->route('runs.show', $b)->with('status', "Uji ulang berjalan: run A dan B #{$b->id} memakai parameter baru. Muat ulang halaman ini sampai perbandingan muncul.");
    }

    public function twin(SimRun $run)
    {
        return view('runs.twin', ['run' => $run]);
    }

    public function show(SimRun $run)
    {
        $versions = DB::table('schedules')
            ->join('schedule_versions', 'schedule_versions.schedule_id', '=', 'schedules.id')
            ->where('schedules.run_id', $run->id)->orderBy('schedule_versions.version')
            ->get(['schedule_versions.version', 'schedule_versions.status', 'schedule_versions.config', 'schedule_versions.created_by', 'schedule_versions.kpi_predicted', 'schedule_versions.plan'])
            ->map(function ($v) {
                $v->kpi_predicted = $v->kpi_predicted ? json_decode($v->kpi_predicted, true) : null;
                $v->plan = $v->plan ? json_decode($v->plan, true) : null;

                return $v;
            });
        $replans = DB::table('sim_events')->where('run_id', $run->id)->where('type', 'schedule.replanned')
            ->orderBy('seq')->get(['sim_time', 'payload'])
            ->map(fn ($e) => ['at' => $e->sim_time] + (json_decode($e->payload, true) ?: []));

        return view('runs.show', ['run' => $run, 'comparison' => $this->comparison($run), 'versions' => $versions, 'replans' => $replans]);
    }

    /**
     * Konfigurasi lain untuk hari yang sama (skenario, seed, volume, extra_bad, pabrik): run selesai terbaru per konfigurasi (PRD 10.7).
     *
     * @return array<string, array{id:int, kpi:array<string,mixed>}>
     */
    private function comparison(SimRun $run): array
    {
        $params = $run->config_snapshot['params'] ?? [];
        $rows = DB::table('sim_runs')
            ->join('scenarios', 'scenarios.id', '=', 'sim_runs.scenario_id')
            ->where('sim_runs.status', 'finished')->where('sim_runs.seed', $run->seed)
            ->where('sim_runs.kind', '!=', 'simulation')
            ->orderByDesc('sim_runs.id')->limit(60)
            ->get(['sim_runs.id', 'sim_runs.config_snapshot', 'scenarios.kpi_result']);

        $out = [];
        foreach ($rows as $r) {
            $snap = json_decode($r->config_snapshot, true);
            $snap = is_array($snap) ? $snap : [];
            $p = $snap['params'] ?? [];
            if (($p['volume_ton'] ?? null) != ($params['volume_ton'] ?? null)
                || ($p['extra_bad'] ?? 0) != ($params['extra_bad'] ?? 0)
                || ($p['plant'] ?? []) != ($params['plant'] ?? [])
                || ($p['params'] ?? []) != ($params['params'] ?? [])
                || ($snap['scenario'] ?? 'normal') !== ($run->config_snapshot['scenario'] ?? 'normal')) {
                continue;
            }
            $out[$snap['config'] ?? 'A'] ??= ['id' => $r->id, 'kpi' => json_decode($r->kpi_result, true)];
        }
        ksort($out);

        return count($out) > 1 || ($run->status === 'finished' && count($out) === 1) ? $out : [];
    }

    /** Run dasar (bukan simulasi) di atas cabang ini, untuk pembanding dampak. */
    private function baseline(SimRun $run): ?SimRun
    {
        for ($i = 0; $run->parent_run_id && $i < 25; $i++) {
            $run = SimRun::find($run->parent_run_id);
            if (! $run) {
                return null;
            }
        }

        return $run->isSimulation() ? null : $run;
    }

    private function kpiOf(SimRun $run): ?array
    {
        return $run->status === 'finished' ? json_decode(DB::table('scenarios')->where('id', $run->scenario_id)->value('kpi_result') ?? 'null', true) : null;
    }

    /**
     * Usulan jadwal per versi untuk panel intervensi: v1 memuat semua truk, versi berikutnya hanya truk yang
     * disusun ulang. `at` null = awal hari.
     *
     * @return list<array{version:int, at:?string, trucks:list<array<string,mixed>>}>
     */
    private function planVersions(SimRun $run): array
    {
        $at = DB::table('sim_events')->where('run_id', $run->id)->where('type', 'schedule.replanned')
            ->get(['sim_time', 'payload'])
            ->mapWithKeys(fn ($e) => [(json_decode($e->payload, true)['version'] ?? 0) => Carbon::parse($e->sim_time)->utc()->format('Y-m-d\TH:i:s\Z')]);

        return DB::table('schedules')
            ->join('schedule_versions', 'schedule_versions.schedule_id', '=', 'schedules.id')
            ->where('schedules.run_id', $run->id)->orderBy('schedule_versions.version')
            ->get(['schedule_versions.version', 'schedule_versions.plan'])
            ->map(fn ($v) => ['version' => (int) $v->version, 'at' => $at[$v->version] ?? null, 'trucks' => (json_decode($v->plan ?? 'null', true) ?: [])['trucks'] ?? []])
            ->all();
    }

    public function replay(SimRun $run): JsonResponse
    {
        $finished = $run->status === 'finished';
        $base = $run->isSimulation() ? $this->baseline($run) : null;

        return response()->json([
            'run' => ['id' => $run->id, 'status' => $run->status, 'error' => $run->error, 'kind' => $run->kind, 'fork_minute' => $run->fork_minute, 'parent_id' => $run->parent_run_id, 'badge' => $run->modeBadge()],
            'kpi' => $this->kpiOf($run),
            'baseline' => $base ? ['id' => $base->id, 'kpi' => $this->kpiOf($base)] : null,
            'plans' => $finished ? $this->planVersions($run) : [],
            'events' => ! $finished ? [] : DB::table('sim_events')->where('run_id', $run->id)->orderBy('seq')
                ->get(['seq', 'sim_time', 'payload'])
                ->map(fn ($e) => ['seq' => $e->seq, 't' => Carbon::parse($e->sim_time)->utc()->format('Y-m-d\TH:i:s\Z'), 'p' => json_decode($e->payload, true)]),
        ]);
    }
}
