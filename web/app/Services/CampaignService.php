<?php

namespace App\Services;

use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\OperationMaintenance;
use App\Models\SimCommand;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use RuntimeException;

// Kampanye harian: tiap hari = satu run engine; hari ditutup dengan checkpoint berantai hash (backup yang bisa diputar ulang).
class CampaignService
{
    public const DAY_MIN = 1440;

    private const KPI_KEYS = ['trucks', 'completed', 'held_g1', 'rejected_g2', 'held_qa', 'raw_ton', 'fg_ton', 'truck_wait_min', 'lab_wait_min', 'tank_dwell_min', 'unscheduled_cip', 'utilization_pct', 'false_accept', 'holding_violations', 'gate_holds', 'makespan_min'];

    public function __construct(private EngineClient $engine, private AuditLogger $audit) {}

    /** @param array{name:string, seed:int, start_date:string, config:string, scenario:string, params:array<string,mixed>, speed:float|null} $data */
    public function create(User $user, array $data): Campaign
    {
        $campaign = DB::transaction(function () use ($user, $data) {
            $c = Campaign::create($data + ['created_by' => $user->id]);
            CampaignDay::create(['campaign_id' => $c->id, 'day_no' => 1, 'carry_in' => [], 'plan' => []]);

            return $c;
        });
        $this->audit->record('user', (string) $user->id, 'campaign.created', ['campaign_id' => $campaign->id, 'seed' => $campaign->seed, 'config' => $campaign->config]);

        return $campaign;
    }

    public function currentDay(Campaign $c): CampaignDay
    {
        return $c->days()->where('day_no', $c->current_day)->firstOrFail();
    }

    public function isOperation(Campaign $c): bool
    {
        return $c->name === config('twin.operation.name') && $c->parent_campaign_id === null;
    }

    /** Hari berjalan atau hari berikutnya yang belum dimulai; hari tertutup tidak pernah direvisi. */
    public function targetDay(Campaign $c): CampaignDay
    {
        return $this->currentDay($c);
    }

    /** Rencana hanya dapat diedit sebelum hari dimulai. Hari aktif menerima perintah lewat jalur live. */
    public function canChange(Campaign $c, CampaignDay $day): bool
    {
        if (in_array($day->status, ['planned', 'failed'], true)) {
            return true;
        }

        return false;
    }

    public function planMaintenance(Campaign $c, User $user, string $asset, float $startMin, float $duration, string $reason): CampaignDay
    {
        $day = $this->targetDay($c);
        $this->assertChangeable($c, $day);
        $this->assertTankExists($c, $asset);
        $taken = array_column([...$day->carry_in, ...$day->plan], 'asset');
        if (in_array($asset, $taken, true)) {
            throw ValidationException::withMessages(['asset' => "{$asset} sudah dijadwalkan maintenance pada hari ini."]);
        }
        if (count($day->plan) >= config('twin.campaign.max_planned')) {
            throw ValidationException::withMessages(['asset' => 'Jumlah maintenance pada hari ini sudah mencapai batas.']);
        }
        $entry = [
            'kind' => 'tank_down', 'asset' => $asset, 'minute' => round($startMin, 1), 'duration_min' => round($duration, 1),
            'reason' => trim($reason), 'actor_id' => $user->id, 'actor_label' => Str::limit($user->role->label().': '.$user->name, 80, ''),
        ];
        $day = $this->savePlan($c, $user, $day, [...$day->plan, $entry], 'planned: '.$asset);
        $this->audit->record('user', (string) $user->id, 'campaign.maintenance_planned', ['campaign_id' => $c->id, 'day' => $day->day_no] + $entry);

        return $day;
    }

    public function cancelMaintenance(Campaign $c, User $user, int $index): CampaignDay
    {
        $day = $this->targetDay($c);
        $this->assertChangeable($c, $day);
        $plan = $day->plan;
        if (! isset($plan[$index])) {
            throw ValidationException::withMessages(['index' => 'Jadwal maintenance tidak ditemukan.']);
        }
        $removed = $plan[$index];
        array_splice($plan, $index, 1);
        $day = $this->savePlan($c, $user, $day, array_values($plan), 'cancelled: '.$removed['asset']);
        $this->audit->record('user', (string) $user->id, 'campaign.maintenance_cancelled', ['campaign_id' => $c->id, 'day' => $day->day_no, 'asset' => $removed['asset']]);

        return $day;
    }

    /** Simpan rencana hari target; hari operasi yang sudah dihitung di depan direvisi dan dihitung ulang. */
    private function savePlan(Campaign $c, User $user, CampaignDay $day, array $plan, string $why): CampaignDay
    {
        if (in_array($day->status, ['planned', 'failed'], true)) {
            $day->update(['plan' => $plan]);

            return $day;
        }

        throw ValidationException::withMessages(['day' => 'Hari ini sudah berjalan atau ditutup. Gunakan perintah maintenance live pada hari aktif.']);
    }

    /**
     * Meter servis tiap tangki pada awal hari target: siklus CIP sejak maintenance terakhir (dari carry hari sebelumnya)
     * terhadap batas servis. Hasilnya bahan usulan maintenance, bukan perintah.
     *
     * @return list<array{asset:string, cycles:int, limit:int, state:string, planned:bool}>
     */
    public function tankService(Campaign $c): array
    {
        $day = $this->targetDay($c);
        $prev = $c->days()->where('day_no', $day->day_no - 1)->where('status', 'closed')->first();
        $cycles = $prev?->snapshot()['state']['engine_carry']['tank_cycles'] ?? [];
        $limit = max(1, (int) config('twin.tanks.service_cycles'));
        $planned = array_column([...$day->carry_in, ...$day->plan], 'asset');
        $out = [];
        foreach ($this->tankLimits($c) as $prefix => $n) {
            for ($k = 1; $k <= $n; $k++) {
                $asset = "{$prefix}-{$k}";
                $used = (int) ($cycles[$asset] ?? 0);
                $out[] = [
                    'asset' => $asset, 'cycles' => $used, 'limit' => $limit,
                    'state' => $used >= $limit ? 'due' : ($used >= (int) ceil($limit * 0.8) ? 'near' : 'ok'),
                    'planned' => in_array($asset, $planned, true),
                ];
            }
        }

        return $out;
    }

    public function setAutoplay(Campaign $c, User $user, bool $on): void
    {
        $c->update(['autoplay' => $on]);
        $this->audit->record('user', (string) $user->id, 'campaign.autoplay', ['campaign_id' => $c->id, 'on' => $on]);
    }

    /** Mulai hari berjalan: kirim ke engine. $user kosong = dimulai otomatis oleh kampanye. */
    public function startDay(Campaign $c, ?User $user): CampaignDay
    {
        $day = $this->currentDay($c);
        $this->assertEditable($day);
        if ($day->day_no > config('twin.campaign.max_days')) {
            throw ValidationException::withMessages(['day' => 'Kampanye sudah mencapai batas hari.']);
        }
        if ($this->isOperation($c)) {
            $scheduled = OperationMaintenance::where('campaign_id', $c->id)->where('day_no', $day->day_no)->where('status', 'scheduled')->get();
            $plan = array_values(array_filter($day->plan, fn ($e) => ! isset($e['request_id'])));
            foreach ($scheduled as $entry) {
                $plan[] = [
                    'kind' => 'tank_down', 'asset' => $entry->asset, 'minute' => $entry->start_min,
                    'duration_min' => $entry->duration_min, 'reason' => $entry->reason,
                    'actor_id' => $entry->actor_id, 'actor_label' => $entry->actor_label, 'request_id' => $entry->id,
                ];
            }
            $day->update(['plan' => $plan]);
            $commands = [...$day->carry_in, ...$plan];
        } else {
            [$commands] = $this->segments($day);
        }
        $params = $c->params + ['seed' => $c->daySeed($day->day_no)];
        // Keadaan akhir kemarin (SKU line, umur fouling, truk tertunda, stok) menjadi keadaan awal hari ini.
        $engineCarry = $day->day_no > 1
            ? ($c->days()->where('day_no', $day->day_no - 1)->where('status', 'closed')->first()?->snapshot()['state']['engine_carry'] ?? null)
            : null;

        $run = DB::transaction(function () use ($c, $day, $user, $params, $commands) {
            $run = SimRun::create([
                'kind' => 'campaign', 'seed' => $params['seed'], 'status' => 'pending', 'requested_by' => $user?->id,
                'config_snapshot' => ['config' => $c->config, 'scenario' => $c->scenario, 'params' => $params, 'live' => $this->isOperation($c)],
            ]);
            foreach ($commands as $i => $cmd) {
                SimCommand::create(['run_id' => $run->id, 'seq' => $i + 1, 'minute' => $cmd['minute'], 'kind' => 'tank_down',
                    'args' => ['asset' => $cmd['asset'], 'duration_min' => $cmd['duration_min']] + (isset($cmd['request_id']) ? ['request_id' => $cmd['request_id']] : []),
                    'actor_id' => $cmd['actor_id'] ?? null, 'actor_label' => $cmd['actor_label'], 'reason' => $cmd['reason']]);
            }
            $day->update(['status' => 'running', 'run_id' => $run->id, 'error' => null]);
            if ($this->isOperation($c)) {
                OperationMaintenance::where('campaign_id', $c->id)->where('day_no', $day->day_no)
                    ->where('status', 'scheduled')->update(['run_id' => $run->id]);
            }

            return $run;
        });

        $this->audit->record($user ? 'user' : 'system', $user ? (string) $user->id : 'campaign', 'campaign.day_started', [
            'campaign_id' => $c->id, 'day' => $day->day_no, 'run_id' => $run->id, 'commands' => count($commands),
        ]);

        try {
            $this->engine->startRun($run->id, $params + array_filter([
                'config' => $c->config, 'scenario' => $c->scenario,
                'speed' => $this->isOperation($c) ? ($c->speed ?? 1) : $c->speed, 'live' => $this->isOperation($c),
                'day' => $day->day_no, 'date' => $c->dateOf($day->day_no), 'carry' => $engineCarry,
                'commands' => $run->commands()->get()->map->toEngine()->all(),
            ], fn ($v) => $v !== null));
            DB::table('sim_runs')->where('id', $run->id)->where('status', 'pending')->update(['status' => 'running']);
        } catch (RuntimeException $e) {
            $run->update(['status' => 'failed', 'error' => $e->getMessage()]);
            $day->update(['status' => 'failed', 'error' => $e->getMessage()]);
            throw ValidationException::withMessages(['engine' => $e->getMessage()]);
        }

        return $day->refresh();
    }

    public function onRunFinished(SimRun $run): void
    {
        $day = CampaignDay::where('run_id', $run->id)->where('status', 'running')->first();
        if ($day) {
            $this->closeDay($day, $run);
        }
    }

    public function onRunFailed(SimRun $run, string $error): void
    {
        $day = CampaignDay::where('run_id', $run->id)->where('status', 'running')->first();
        if (! $day) {
            return;
        }
        $day->update(['status' => 'failed', 'error' => $error]);
        $day->campaign->update(['autoplay' => false]);
        $this->audit->record('system', 'campaign', 'campaign.day_failed', ['campaign_id' => $day->campaign_id, 'day' => $day->day_no, 'run_id' => $run->id]);
    }

    private function closeDay(CampaignDay $day, SimRun $run): void
    {
        $c = $day->campaign;
        $kpi = json_decode((string) DB::table('scenarios')->where('id', $run->scenario_id)->value('kpi_result'), true) ?: [];
        [$commands, $carryOut] = $this->segments($day);
        if ($this->isOperation($c)) {
            $commands = $run->commands()->get()->map(fn ($cmd) => [
                'kind' => $cmd->kind, 'asset' => $cmd->args['asset'], 'minute' => $cmd->minute,
                'duration_min' => $cmd->args['duration_min'], 'reason' => $cmd->reason, 'actor_label' => $cmd->actor_label,
            ])->all();
            // Live maintenance is completed in this run, even if it extends into overtime.
            $carryOut = [];
        }
        $result = DB::table('sim_runs')->where('id', $run->id)->value('day_result');
        $result = $result ? json_decode($result, true) : [];

        $checkpoint = json_encode([
            'v' => 2, 'campaign_seed' => $c->seed, 'day' => $day->day_no, 'date' => $c->dateOf($day->day_no),
            'day_seed' => $c->daySeed($day->day_no), 'run_id' => $run->id, 'config' => $c->config, 'scenario' => $c->scenario,
            'plant' => $c->params['plant'] ?? new \stdClass,
            'volume_ton' => $c->params['volume_ton'] ?? null,
            'commands' => array_map(fn ($x) => Arr::only($x, ['kind', 'asset', 'minute', 'duration_min', 'reason', 'actor_label']), $commands),
            'kpi' => array_intersect_key($kpi, array_flip(self::KPI_KEYS)),
            'state' => ['maintenance_carry' => $carryOut, 'engine_carry' => $result['carry_out'] ?? null],
            'summary' => $result['summary'] ?? null,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

        $prev = (string) CampaignDay::where('campaign_id', $c->id)->where('day_no', $day->day_no - 1)->value('hash');
        $next = null;
        DB::transaction(function () use ($day, $c, $checkpoint, $prev, $carryOut, &$next) {
            $day->update(['status' => 'closed', 'checkpoint' => $checkpoint, 'prev_hash' => $prev, 'hash' => hash('sha256', $prev."\n".$checkpoint), 'closed_at' => now()]);
            if ($c->current_day === $day->day_no && $day->day_no < config('twin.campaign.max_days')) {
                $next = CampaignDay::create(['campaign_id' => $c->id, 'day_no' => $day->day_no + 1, 'carry_in' => $carryOut, 'plan' => []]);
                $c->update(['current_day' => $day->day_no + 1]);
            }
        });
        $this->audit->record('system', 'campaign', 'campaign.day_closed', ['campaign_id' => $c->id, 'day' => $day->day_no, 'run_id' => $run->id, 'hash' => $day->hash]);

        if ($next && $c->autoplay && ! $this->isOperation($c)) {
            try {
                $this->startDay($c->refresh(), null);
            } catch (ValidationException $e) {
                $c->update(['autoplay' => false]);
                $this->audit->record('system', 'campaign', 'campaign.autoplay_stopped', ['campaign_id' => $c->id, 'error' => $e->getMessage()]);
            }
        }
    }

    /** Cabang baru dari checkpoint hari $dayNo: hari 1..$dayNo disalin apa adanya, hari berikutnya mulai dari state akhir hari itu. */
    public function branch(Campaign $src, int $dayNo, User $user): Campaign
    {
        $source = $src->days()->where('day_no', $dayNo)->where('status', 'closed')->first();
        if (! $source) {
            throw ValidationException::withMessages(['day' => 'Hanya hari yang sudah ditutup yang dapat dipulihkan.']);
        }
        $carry = $source->snapshot()['state']['maintenance_carry'] ?? [];

        $branch = DB::transaction(function () use ($src, $dayNo, $user, $carry) {
            $b = Campaign::create([
                'name' => Str::limit("{$src->name} (cabang hari {$dayNo})", 80, ''), 'seed' => $src->seed, 'start_date' => $src->start_date,
                'config' => $src->config, 'scenario' => $src->scenario, 'params' => $src->params, 'speed' => $src->speed, 'autoplay' => false,
                'current_day' => $dayNo + 1, 'parent_campaign_id' => $src->id, 'branched_from_day' => $dayNo, 'created_by' => $user->id,
            ]);
            foreach ($src->days()->where('day_no', '<=', $dayNo)->get() as $d) {
                CampaignDay::create($d->only(['day_no', 'status', 'run_id', 'carry_in', 'plan', 'checkpoint', 'prev_hash', 'hash', 'closed_at']) + ['campaign_id' => $b->id]);
            }
            CampaignDay::create(['campaign_id' => $b->id, 'day_no' => $dayNo + 1, 'carry_in' => $carry, 'plan' => []]);

            return $b;
        });
        $this->audit->record('user', (string) $user->id, 'campaign.branched', ['campaign_id' => $branch->id, 'from_campaign_id' => $src->id, 'from_day' => $dayNo]);

        return $branch;
    }

    /** @return array{ok:bool, broken_day:int|null} */
    public function verify(Campaign $c): array
    {
        $prev = '';
        foreach ($c->days()->where('status', 'closed')->get() as $d) {
            if ($d->prev_hash !== $prev || $d->hash !== hash('sha256', $prev."\n".$d->checkpoint)) {
                return ['ok' => false, 'broken_day' => $d->day_no];
            }
            $prev = $d->hash;
        }

        return ['ok' => true, 'broken_day' => null];
    }

    /**
     * Perintah engine untuk satu hari dan sisa maintenance yang berlanjut ke hari berikutnya.
     * Jendela dipotong pada akhir hari supaya run tidak melewati 24 jam.
     *
     * @return array{0: list<array<string,mixed>>, 1: list<array<string,mixed>>}
     */
    public function segments(CampaignDay $day): array
    {
        $commands = [];
        $carry = [];
        foreach ([...$day->carry_in, ...$day->plan] as $e) {
            $end = $e['minute'] + $e['duration_min'];
            $inDay = max(15.0, min((float) $e['duration_min'], self::DAY_MIN - $e['minute']));
            $commands[] = ['minute' => (float) $e['minute'], 'duration_min' => round($inDay, 1)] + $e;
            if ($end > self::DAY_MIN) {
                $carry[] = ['kind' => 'tank_down', 'asset' => $e['asset'], 'minute' => 0.0, 'duration_min' => round(max(15.0, $end - self::DAY_MIN), 1)]
                    + Arr::only($e, ['reason', 'actor_id', 'actor_label']);
            }
        }

        return [$commands, $carry];
    }

    private function assertEditable(CampaignDay $day): void
    {
        if (! in_array($day->status, ['planned', 'failed'], true)) {
            throw ValidationException::withMessages(['day' => 'Hari ini sedang berjalan atau sudah ditutup.']);
        }
    }

    private function assertChangeable(Campaign $c, CampaignDay $day): void
    {
        if ($day->status === 'running') {
            throw ValidationException::withMessages(['day' => 'Hari berikutnya sedang dihitung engine. Coba lagi beberapa detik.']);
        }
        if (! $this->canChange($c, $day)) {
            throw ValidationException::withMessages(['day' => 'Hari ini sudah ditonton atau ditutup; maintenance berlaku dari hari berikutnya.']);
        }
    }

    /** @return array{'TK-RAW': int, 'TK-STO': int} */
    public function tankLimits(Campaign $c): array
    {
        $plant = $c->params['plant'] ?? [];

        return ['TK-RAW' => (int) ($plant['n_raw_tanks'] ?? config('twin.commands.tanks.TK-RAW')), 'TK-STO' => (int) ($plant['n_storage_tanks'] ?? config('twin.commands.tanks.TK-STO'))];
    }

    private function assertTankExists(Campaign $c, string $asset): void
    {
        $limits = $this->tankLimits($c);
        $kind = substr($asset, 0, 6);
        $n = (int) substr($asset, 7);
        if (! isset($limits[$kind]) || $n < 1 || $n > $limits[$kind]) {
            throw ValidationException::withMessages(['asset' => 'Pilih tangki yang ada pada pabrik ini.']);
        }
    }
}
