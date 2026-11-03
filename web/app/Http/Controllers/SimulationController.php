<?php

namespace App\Http\Controllers;

use App\Models\SimRun;
use App\Services\AuditLogger;
use App\Services\ForkService;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

// Mode Simulasi: cabang what-if dari run yang sudah selesai. Seed sama, ditambah daftar perintah yang tercatat.
class SimulationController extends Controller
{
    public function fork(Request $request, SimRun $run, ForkService $forks, AuditLogger $audit)
    {
        $lim = config('twin.commands.limits');
        $interventions = array_keys(config('twin.commands.interventions'));
        $data = $request->validate([
            'minute' => ['required', 'numeric', 'min:0', 'lt:1440'],
            'kind' => ['required', Rule::in([...array_keys(config('twin.commands.kinds')), ...$interventions])],
            'count' => ['nullable', 'integer', "min:{$lim['count'][0]}", "max:{$lim['count'][1]}"],
            'duration_min' => ['nullable', 'numeric', "min:{$lim['duration_min'][0]}", "max:{$lim['duration_min'][1]}"],
            'factor' => ['nullable', 'numeric', "min:{$lim['factor'][0]}", "max:{$lim['factor'][1]}"],
            'truck' => ['nullable', 'string', 'regex:/^[A-Z]{2}-\d{3,}$/'],
            'bay' => ['nullable', 'string', 'regex:/^BAY-\d{1,2}$/'],
            'asset' => ['nullable', 'string', 'regex:/^TK-(RAW|STO)-\d{1,2}$/'],
            'start_min' => ['nullable', 'numeric', "min:{$lim['start_min'][0]}", "lt:{$lim['start_min'][1]}"],
            'reason' => ['required', 'string', 'min:5', 'max:200'],
        ]);
        if ($data['kind'] === 'tank_down') {
            $this->assertTankExists($run, $data['asset'] ?? null);
        }
        $isIntervention = in_array($data['kind'], $interventions, true);
        if ($isIntervention) {
            abort_unless($request->user()->can('intervene'), 403);
            if (empty($data['truck'])) {
                throw ValidationException::withMessages(['truck' => 'Pilih truk yang dimaksud.']);
            }
            if ($data['kind'] === 'plan_change' && ! isset($data['bay']) && ! isset($data['start_min'])) {
                throw ValidationException::withMessages(['bay' => 'Ubah bay atau jam mulai bongkar.']);
            }
        }
        if ($run->status !== 'finished') {
            throw ValidationException::withMessages(['run' => 'Run sumber harus sudah selesai sebelum dicabangkan.']);
        }

        $previous = $run->commands()->get();
        if ($previous->count() >= config('twin.commands.max')) {
            throw ValidationException::withMessages(['kind' => 'Jumlah perintah sudah mencapai batas per simulasi.']);
        }

        $args = $isIntervention ? $this->interventionArgs($data) : $this->disturbanceArgs($data);
        $user = $request->user();
        $actor = Str::limit($user->role->label().': '.$user->name, 80, '');
        $minute = round((float) $data['minute'], 1);

        $fork = $forks->create($run, [['minute' => $minute, 'kind' => $data['kind'], 'args' => $args, 'reason' => $data['reason']]], $user, $actor);

        $audit->record('user', (string) $user->id, 'simulation.forked', [
            'run_id' => $fork->id, 'parent_run_id' => $run->id, 'minute' => $minute, 'kind' => $data['kind'], 'args' => $args, 'reason' => trim($data['reason']),
        ]);

        $url = route('twin', ['run' => $fork->id]);

        return $request->expectsJson() ? response()->json(['run' => $fork->id, 'url' => $url], 201) : redirect($url);
    }

    /** Argumen yang tidak berlaku untuk jenis ini dibuang; yang kosong memakai nilai bawaan. */
    private function disturbanceArgs(array $data): array
    {
        $args = [];
        foreach (config("twin.commands.defaults.{$data['kind']}") as $key => $default) {
            $args[$key] = isset($data[$key]) ? ($key === 'asset' ? $data[$key] : $data[$key] + 0) : $default;
        }

        return $args;
    }

    /** Tangki harus ada pada pabrik run sumber (jumlah tangki bisa diubah di parameter run). */
    private function assertTankExists(SimRun $run, ?string $asset): void
    {
        $plant = $run->config_snapshot['params']['plant'] ?? [];
        $limits = ['TK-RAW' => $plant['n_raw_tanks'] ?? config('twin.commands.tanks.TK-RAW'), 'TK-STO' => $plant['n_storage_tanks'] ?? config('twin.commands.tanks.TK-STO')];
        $kind = $asset ? substr($asset, 0, 6) : '';
        $n = $asset ? (int) substr($asset, 7) : 0;
        if (! isset($limits[$kind]) || $n < 1 || $n > $limits[$kind]) {
            throw ValidationException::withMessages(['asset' => 'Pilih tangki yang ada pada pabrik ini.']);
        }
    }

    private function interventionArgs(array $data): array
    {
        $args = ['truck' => $data['truck']];
        if ($data['kind'] === 'plan_change') {
            if (isset($data['bay'])) {
                $args['bay'] = $data['bay'];
            }
            if (isset($data['start_min'])) {
                $args['start_min'] = round((float) $data['start_min'], 1);
            }
        }
        if ($data['kind'] === 'truck_hold') {
            $args['duration_min'] = isset($data['duration_min']) ? $data['duration_min'] + 0 : config('twin.commands.hold_default');
        }

        return $args;
    }
}
