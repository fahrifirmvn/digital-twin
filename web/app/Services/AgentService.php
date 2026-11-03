<?php

namespace App\Services;

use App\Models\AgentAction;
use App\Models\AgentMandate;
use App\Models\SimCommand;
use App\Models\SimRun;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

// Agen Copilot (P6). Tindakan agen = cabang simulasi kandidat. Engine menjalankannya (gate SOP ditegakkan di sana),
// lalu hasilnya dibandingkan dengan run asal. Hanya yang lulus yang bisa diterapkan: tingkat 1 menunggu PPIC,
// tingkat 2 dan 3 diterapkan otomatis dengan jendela veto. Jadwal nyata tidak pernah berubah dari sini.
class AgentService
{
    public function __construct(private ForkService $forks, private AuditLogger $audit) {}

    private function actor(): string
    {
        return config('twin.agent.actor');
    }

    public function setMandate(User $user, int $level, int $maxActions, string $reason): AgentMandate
    {
        $mandate = AgentMandate::create(['level' => $level, 'max_actions' => $maxActions, 'reason' => trim($reason), 'set_by' => $user->id]);
        $this->audit->record('user', (string) $user->id, 'agent.mandate_set', ['level' => $level, 'max_actions' => $maxActions, 'reason' => trim($reason)]);

        return $mandate;
    }

    /**
     * Pengamatan pada satu menit (menit sejak event pertama run): truk antre yang punya baris di rencana,
     * truk menuju gerbang, dan jendela sterilizer mati dari log perintah.
     *
     * @return array{waiting:list<array{code:string,since:float}>, inbound:list<array{code:string,eta:float}>, outages:list<array{0:float,1:float}>}
     */
    public function observe(SimRun $run, float $minute): array
    {
        $first = DB::table('sim_events')->where('run_id', $run->id)->orderBy('seq')->value('sim_time');
        $startTs = $first ? Carbon::parse($first)->getTimestamp() : 0;
        $minuteOf = fn ($iso) => (Carbon::parse($iso)->getTimestamp() - $startTs) / 60;

        $events = DB::table('sim_events')->where('run_id', $run->id)
            ->whereIn('type', ['tanker.status_changed', 'truck.dispatched', 'truck.arrived', 'schedule.replanned'])
            ->orderBy('seq')->get(['sim_time', 'type', 'payload']);

        $replanAt = [];
        $status = [];
        $dispatched = [];
        $arrived = [];
        foreach ($events as $e) {
            $m = $minuteOf($e->sim_time);
            $p = json_decode($e->payload, true) ?? [];
            if ($e->type === 'schedule.replanned') {
                $replanAt[(int) ($p['version'] ?? 0)] = $m;
            }
            if ($m > $minute) {
                continue;
            }
            match ($e->type) {
                'tanker.status_changed' => $status[$p['tanker_code']] = ['status' => $p['status'], 'since' => $m],
                'truck.dispatched' => $dispatched[$p['tanker_code']] = $minuteOf($p['eta']),
                'truck.arrived' => $arrived[$p['tanker_code']] = true,
                default => null,
            };
        }

        $planned = [];
        $versions = DB::table('schedules')->join('schedule_versions', 'schedule_versions.schedule_id', '=', 'schedules.id')
            ->where('schedules.run_id', $run->id)->orderBy('schedule_versions.version')->get(['schedule_versions.version', 'schedule_versions.plan']);
        foreach ($versions as $v) {
            if (isset($replanAt[(int) $v->version]) && $replanAt[(int) $v->version] > $minute) {
                break;
            }
            foreach ((json_decode($v->plan ?? 'null', true) ?: [])['trucks'] ?? [] as $t) {
                $planned[$t['code']] = true;
            }
        }

        $waiting = [];
        foreach ($status as $code => $s) {
            if (in_array($s['status'], ['sampling', 'released'], true) && isset($planned[$code])) {
                $waiting[] = ['code' => $code, 'since' => $s['since']];
            }
        }
        $inbound = [];
        foreach ($dispatched as $code => $eta) {
            if ($eta > $minute && ! isset($arrived[$code])) {
                $inbound[] = ['code' => $code, 'eta' => $eta];
            }
        }
        $outages = SimCommand::where('run_id', $run->id)->where('kind', 'ster_down')->get()
            ->map(fn ($c) => [(float) $c->minute, (float) $c->minute + (float) ($c->args['duration_min'] ?? 0)])->all();

        return ['waiting' => $waiting, 'inbound' => $inbound, 'outages' => $outages];
    }

    public function propose(SimRun $run, float $minute, User $user): AgentAction
    {
        $mandate = AgentMandate::current();
        $level = (int) ($mandate?->level ?? 0);
        if ($level < 1) {
            throw ValidationException::withMessages(['agent' => 'Agen sedang mati. PPIC perlu menaikkan tingkat otomasi lebih dulu.']);
        }
        if ($run->status !== 'finished') {
            throw ValidationException::withMessages(['agent' => 'Run harus sudah selesai sebelum agen bertindak.']);
        }
        $open = AgentAction::where('run_id', $run->id)->whereIn('status', ['verifying', 'awaiting', 'applied'])->count();
        if ($open >= config('twin.agent.max_per_run')) {
            throw ValidationException::withMessages(['agent' => 'Batas tindakan agen untuk run ini sudah tercapai. Batalkan atau veto salah satunya dulu.']);
        }
        $room = config('twin.commands.max') - $run->commands()->count();
        if ($room < 1) {
            throw ValidationException::withMessages(['agent' => 'Jumlah perintah sudah mencapai batas per simulasi.']);
        }

        $minute = round($minute, 1);
        $obs = $this->observe($run, $minute);
        $candidates = AgentPolicy::candidates($level, min((int) $mandate->max_actions, $room), $obs['waiting'], $obs['inbound'], $obs['outages'], config('twin.agent.hold_minutes'));
        if (! $candidates) {
            throw ValidationException::withMessages(['agent' => 'Tidak ada usulan atau truk yang perlu ditangani agen pada jam ini.']);
        }

        $fork = $this->forks->create($run, array_map(fn ($c) => ['minute' => $minute] + $c, $candidates), null, $this->actor());
        $action = AgentAction::create([
            'run_id' => $run->id, 'fork_run_id' => $fork->id, 'mandate_id' => $mandate->id, 'level' => $level, 'minute' => $minute,
            'status' => 'verifying', 'commands' => $candidates, 'requested_by' => $user->id,
        ]);
        $this->audit->record('system', $this->actor(), 'agent.proposed', [
            'action_id' => $action->id, 'run_id' => $run->id, 'fork_run_id' => $fork->id, 'minute' => $minute, 'level' => $level,
            'commands' => array_map(fn ($c) => ['kind' => $c['kind']] + $c['args'], $candidates), 'requested_by' => $user->id,
        ]);

        return $action;
    }

    /** Selesaikan verifikasi bila cabang kandidat sudah selesai; menerapkan otomatis pada tingkat 2 dan 3. */
    public function settle(AgentAction $action): AgentAction
    {
        if ($action->status !== 'verifying') {
            return $action;
        }
        $fork = $action->fork_run_id ? SimRun::find($action->fork_run_id) : null;
        if (! $fork || $fork->status === 'failed') {
            return $this->finish($action, ['status' => 'rejected', 'verdict' => ['verdict' => 'gagal_run', 'error' => $fork?->error ?? 'Cabang kandidat tidak ada.']], 'agent.rejected');
        }
        if ($fork->status !== 'finished') {
            return $action;
        }

        $interventions = array_keys(config('twin.commands.interventions'));
        $events = DB::table('sim_events')->where('run_id', $fork->id)->where('type', 'command.applied')->pluck('payload')
            ->map(fn ($p) => json_decode($p, true))->filter(fn ($p) => in_array($p['kind'] ?? '', $interventions, true))->values()->all();
        $verdict = AgentPolicy::verdict($this->kpi($fork), ($parent = SimRun::find($action->run_id)) ? $this->kpi($parent) : null, $events);

        if ($verdict['verdict'] !== 'lulus') {
            return $this->finish($action, ['status' => 'rejected', 'verdict' => $verdict], 'agent.rejected');
        }
        if (min($action->level, AgentMandate::currentLevel()) >= 2) {
            return $this->finish($action, [
                'status' => 'applied', 'verdict' => $verdict, 'decided_by' => $this->actor(),
                'veto_until' => now()->addSeconds(config('twin.agent.veto_seconds')),
            ], 'agent.applied');
        }

        return $this->finish($action, ['status' => 'awaiting', 'verdict' => $verdict], null);
    }

    public function approve(AgentAction $action, User $user, string $reason): AgentAction
    {
        return $this->decide($action, $user, $reason, ['awaiting'], 'applied', 'agent.approved', 'Tindakan ini tidak sedang menunggu persetujuan.');
    }

    /** Veto: tolak yang menunggu persetujuan, atau batalkan yang diterapkan otomatis selama jendela veto masih terbuka. */
    public function veto(AgentAction $action, User $user, string $reason): AgentAction
    {
        if (! ($action->status === 'awaiting' || $action->vetoOpen())) {
            throw ValidationException::withMessages(['action' => 'Jendela veto sudah tertutup. Gunakan Batalkan untuk menarik tindakan yang sudah berlaku.']);
        }

        return $this->decide($action, $user, $reason, [$action->status], 'vetoed', 'agent.vetoed', 'Tindakan sudah berubah.');
    }

    /** Batalkan tindakan yang sudah berlaku, kapan pun. */
    public function undo(AgentAction $action, User $user, string $reason): AgentAction
    {
        return $this->decide($action, $user, $reason, ['applied'], 'undone', 'agent.undone', 'Hanya tindakan yang sudah berlaku yang bisa dibatalkan.');
    }

    /** @param list<string> $from */
    private function decide(AgentAction $action, User $user, string $reason, array $from, string $to, string $audit, string $error): AgentAction
    {
        $label = Str::limit($user->role->label().': '.$user->name, 80, '');
        $changes = ['status' => $to, 'decided_by' => $label, 'decided_reason' => trim($reason), 'updated_at' => now()];
        if ($to === 'applied') {
            $changes['veto_until'] = null;
        }
        $n = DB::table('agent_actions')->where('id', $action->id)->whereIn('status', $from)->update($changes);
        if ($n === 0) {
            throw ValidationException::withMessages(['action' => $error]);
        }
        $this->audit->record('user', (string) $user->id, $audit, ['action_id' => $action->id, 'run_id' => $action->run_id, 'fork_run_id' => $action->fork_run_id, 'reason' => trim($reason)]);

        return $action->refresh();
    }

    /** @param array<string,mixed> $changes */
    private function finish(AgentAction $action, array $changes, ?string $audit): AgentAction
    {
        $row = $changes + ['updated_at' => now()];
        foreach (['verdict'] as $json) {
            if (isset($row[$json])) {
                $row[$json] = json_encode($row[$json]);
            }
        }
        $n = DB::table('agent_actions')->where('id', $action->id)->where('status', 'verifying')->update($row);
        if ($n === 1 && $audit) {
            $this->audit->record('system', $this->actor(), $audit, [
                'action_id' => $action->id, 'run_id' => $action->run_id, 'fork_run_id' => $action->fork_run_id, 'verdict' => $changes['verdict'] ?? null,
            ]);
        }

        return $action->refresh();
    }

    private function kpi(SimRun $run): ?array
    {
        return json_decode(DB::table('scenarios')->where('id', $run->scenario_id)->value('kpi_result') ?? 'null', true);
    }

    /** @return array<string,mixed> */
    public function present(AgentAction $a): array
    {
        $trucks = fn (string $kind) => array_values(array_map(fn ($c) => $c['args']['truck'] ?? '', array_filter($a->commands, fn ($c) => $c['kind'] === $kind)));

        return [
            'id' => $a->id, 'run_id' => $a->run_id, 'fork_run_id' => $a->fork_run_id,
            'fork_url' => $a->fork_run_id ? route('twin', ['run' => $a->fork_run_id]) : null,
            'status' => $a->status, 'level' => $a->level, 'minute' => $a->minute,
            'approve' => $trucks('plan_approve'), 'hold' => $trucks('truck_hold'),
            'verdict' => $a->verdict, 'decided_by' => $a->decided_by, 'decided_reason' => $a->decided_reason,
            'veto_left' => $a->vetoOpen() ? (int) now()->diffInSeconds($a->veto_until, false) : 0,
            'can_veto' => $a->status === 'awaiting' || $a->vetoOpen(),
            'created_at' => $a->created_at?->toIso8601String(),
        ];
    }
}
