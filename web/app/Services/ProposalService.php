<?php

namespace App\Services;

use App\Models\AgentProposal;
use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

// Usulan Operator Agent (P1, P2, P3, P6). Engine hanya membuat draf; Laravel yang menyimpan, memeriksa ulang aturan keras
// dari database, dan hanya PPIC/Admin dengan alasan yang dapat menerapkannya. Penerapan = jadwal maintenance biasa pada
// kampanye (sandbox SIMULASI); tidak ada jalur ke sistem pabrik.
class ProposalService
{
    private const MAX_PER_TURN = 4;

    public function __construct(private CampaignService $campaigns, private AuditLogger $audit) {}

    /** Keadaan hari kampanye untuk what-if engine, dibaca dari database (bukan dari klien). @return array<string, mixed> */
    public function context(Campaign $c): array
    {
        $day = $this->campaigns->currentDay($c);
        [$commands] = $this->campaigns->segments($day);
        $existing = array_map(fn ($e) => ['asset' => $e['asset'], 'minute' => (float) $e['minute'], 'duration_min' => (float) $e['duration_min']], $commands);

        return [
            'campaign_id' => $c->id, 'day_no' => $day->day_no, 'editable' => $this->editable($day), 'seed' => $c->daySeed($day->day_no),
            'config' => $c->config, 'scenario' => $c->scenario,
            'volume_ton' => (float) ($c->params['volume_ton'] ?? 320), 'extra_bad' => (int) ($c->params['extra_bad'] ?? 0),
            'plant' => ($c->params['plant'] ?? null) ?: null,
            'existing' => array_slice($existing, 0, 20), 'planned_count' => count($day->plan),
            'max_planned' => (int) config('twin.campaign.max_planned'),
        ];
    }

    /**
     * Simpan draf dari balasan engine. Draf yang melanggar aturan keras menurut database tidak disimpan.
     *
     * @param  list<array<string, mixed>>  $drafts
     * @return list<AgentProposal>
     */
    public function persistDrafts(Campaign $c, User $user, string $conversation, array $reply, array $drafts): array
    {
        $saved = [];
        foreach (array_slice($drafts, 0, self::MAX_PER_TURN) as $d) {
            $payload = $this->payloadOf($d['payload'] ?? null);
            $rationale = is_string($d['rationale'] ?? null) ? trim($d['rationale']) : '';
            $evidence = is_array($d['evidence'] ?? null) ? $d['evidence'] : null;
            if (($d['kind'] ?? null) !== AgentProposal::KIND_TANK_MAINTENANCE || ! $payload || $evidence === null || mb_strlen($rationale) < 10 || mb_strlen($rationale) > 400) {
                $this->audit->record('user', (string) $user->id, 'agent.proposal_discarded', ['conversation_id' => $conversation, 'campaign_id' => $c->id, 'reason' => 'bentuk_tidak_valid']);

                continue;
            }
            $day = $this->campaigns->currentDay($c);
            $findings = $this->findings($c, $day, $payload);
            if ($findings) {
                $this->audit->record('user', (string) $user->id, 'agent.proposal_discarded', ['conversation_id' => $conversation, 'campaign_id' => $c->id, 'day' => $day->day_no, 'reason' => 'diblokir_validator', 'codes' => array_keys($findings)]);

                continue;
            }
            $saved[] = DB::transaction(function () use ($c, $user, $conversation, $reply, $d, $payload, $rationale, $evidence, $day) {
                $version = 1;
                $supersedes = null;
                $old = is_string($d['supersedes'] ?? null) ? AgentProposal::where('uuid', $d['supersedes'])->where('campaign_id', $c->id)
                    ->where('created_by', $user->id)->whereIn('status', ['draft', 'pending'])->lockForUpdate()->first() : null;
                if ($old) {
                    $version = $old->version + 1;
                    $supersedes = $old->uuid;
                }
                $id = is_string($d['id'] ?? null) && Str::isUuid($d['id']) && ! AgentProposal::where('uuid', $d['id'])->exists() ? $d['id'] : (string) Str::uuid();
                $p = AgentProposal::create([
                    'uuid' => $id, 'campaign_id' => $c->id, 'day_no' => $day->day_no, 'kind' => AgentProposal::KIND_TANK_MAINTENANCE,
                    'version' => $version, 'supersedes_uuid' => $supersedes, 'mode' => 'SIMULASI', 'payload' => $payload, 'rationale' => $rationale,
                    'evidence' => $evidence, 'evidence_hash' => hash('sha256', json_encode($evidence, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)),
                    'conversation_id' => $conversation, 'model_name' => $reply['model'] ?? null, 'model_version' => $reply['model_version'] ?? null,
                    'created_by' => $user->id,
                ]);
                if ($old) {
                    $old->status = 'superseded';
                    $old->save();
                }
                $this->audit->record('user', (string) $user->id, 'agent.proposal_created', [
                    'proposal_id' => $p->uuid, 'version' => $version, 'supersedes' => $supersedes, 'campaign_id' => $c->id, 'day' => $day->day_no,
                    'payload' => $payload, 'evidence_hash' => $p->evidence_hash, 'whatif_id' => $evidence['whatif_id'] ?? null,
                    'model' => $reply['model'] ?? null, 'model_version' => $reply['model_version'] ?? null, 'conversation_id' => $conversation,
                ]);

                return $p;
            });
        }

        return $saved;
    }

    public function submit(AgentProposal $p, User $user): AgentProposal
    {
        $stale = null;
        $result = DB::transaction(function () use ($p, $user, &$stale) {
            $p = $this->lock($p);
            $this->assertStatus($p, 'draft', 'Hanya draf yang dapat diajukan.');
            if ($stale = $this->staleReason($p)) {
                $this->expire($p, $user, $stale);

                return $p;
            }
            $p->forceFill(['status' => 'pending', 'submitted_by' => $user->id, 'submitted_at' => now()])->save();
            $this->audit->record('user', (string) $user->id, 'agent.proposal_submitted', ['proposal_id' => $p->uuid, 'campaign_id' => $p->campaign_id, 'day' => $p->day_no]);

            return $p;
        });
        if ($stale) {
            throw ValidationException::withMessages(['proposal' => "Usulan tidak lagi valid dan ditandai kedaluwarsa: {$stale}"]);
        }

        return $result;
    }

    /** Persetujuan PPIC: alasan wajib, aturan keras diperiksa ulang, lalu jadwal maintenance dibuat lewat jalur kampanye yang sama. */
    public function approve(AgentProposal $p, User $user, string $reason): AgentProposal
    {
        $stale = null;
        $result = DB::transaction(function () use ($p, $user, $reason, &$stale) {
            $p = $this->lock($p);
            $this->assertStatus($p, 'pending', 'Hanya usulan yang diajukan (pending) yang dapat disetujui.');
            if ($p->mode !== 'SIMULASI') {
                throw ValidationException::withMessages(['mode' => 'Mode LIVE tidak pernah menulis ke sistem pabrik.']);
            }
            if ($stale = $this->staleReason($p)) {
                $this->expire($p, $user, $stale);

                return $p;
            }
            $campaign = $p->campaign;
            $w = $p->payload;
            $this->campaigns->planMaintenance($campaign, $user, $w['asset'], (float) $w['minute'], (float) $w['duration_min'], Str::limit("Usulan AI {$p->uuid}: {$reason}", 900, ''));
            $p->forceFill(['status' => 'approved', 'decided_by' => $user->id, 'decided_at' => now(), 'decision_reason' => trim($reason)])->save();
            $this->audit->record('user', (string) $user->id, 'agent.proposal_approved', [
                'proposal_id' => $p->uuid, 'version' => $p->version, 'campaign_id' => $p->campaign_id, 'day' => $p->day_no, 'payload' => $w,
                'reason' => trim($reason), 'evidence_hash' => $p->evidence_hash, 'model' => $p->model_name, 'model_version' => $p->model_version,
            ]);

            return $p;
        });
        if ($stale) {
            throw ValidationException::withMessages(['proposal' => "Usulan tidak lagi valid dan ditandai kedaluwarsa: {$stale}"]);
        }

        return $result;
    }

    public function reject(AgentProposal $p, User $user, string $reason): AgentProposal
    {
        return DB::transaction(function () use ($p, $user, $reason) {
            $p = $this->lock($p);
            $this->assertStatus($p, 'pending', 'Hanya usulan yang diajukan (pending) yang dapat ditolak.');
            $p->forceFill(['status' => 'rejected', 'decided_by' => $user->id, 'decided_at' => now(), 'decision_reason' => trim($reason)])->save();
            $this->audit->record('user', (string) $user->id, 'agent.proposal_rejected', [
                'proposal_id' => $p->uuid, 'version' => $p->version, 'campaign_id' => $p->campaign_id, 'day' => $p->day_no, 'reason' => trim($reason),
            ]);

            return $p;
        });
    }

    /** Aturan keras terhadap keadaan database sekarang. Kosong = boleh. @return array<string, string> kode => pesan */
    public function findings(Campaign $c, CampaignDay $day, array $w): array
    {
        $out = [];
        if (! $this->editable($day)) {
            $out['day_not_editable'] = 'Hari ini sedang berjalan atau sudah ditutup.';
        }
        $limits = $this->campaigns->tankLimits($c);
        $asset = $w['asset'];
        $kind = substr($asset, 0, 6);
        if (! isset($limits[$kind]) || (int) substr($asset, 7) < 1 || (int) substr($asset, 7) > $limits[$kind]) {
            return $out + ['unknown_asset' => "{$asset} tidak ada pada pabrik kampanye ini."];
        }
        $range = config('twin.campaign.maintenance_minutes');
        if ($w['minute'] < 0 || $w['minute'] >= CampaignService::DAY_MIN || $w['duration_min'] < $range[0] || $w['duration_min'] > $range[1]) {
            return $out + ['window_out_of_range' => 'Menit mulai atau durasi di luar batas.'];
        }
        [$commands] = $this->campaigns->segments($day);
        if (in_array($asset, array_column($commands, 'asset'), true)) {
            $out['already_planned'] = "{$asset} sudah dijadwalkan maintenance hari ini.";
        }
        if (count($day->plan) >= config('twin.campaign.max_planned')) {
            $out['limit_reached'] = 'Jumlah maintenance hari ini sudah mencapai batas.';
        }
        $end = min($w['minute'] + $w['duration_min'], CampaignService::DAY_MIN);
        $same = array_values(array_map(fn ($e) => [$e['minute'], min($e['minute'] + $e['duration_min'], CampaignService::DAY_MIN)],
            array_filter($commands, fn ($e) => substr($e['asset'], 0, 6) === $kind)));
        $points = [$w['minute'], ...array_filter(array_column($same, 0), fn ($s) => $s >= $w['minute'] && $s < $end)];
        sort($points);
        foreach ($points as $pt) {
            $down = 1 + count(array_filter($same, fn ($r) => $r[0] <= $pt && $pt < $r[1]));
            if ($down >= $limits[$kind]) {
                $out['no_tank_available'] = "Pada menit {$pt} semua tangki {$kind} akan mati; tidak ada tangki tujuan siap.";
                break;
            }
        }

        return $out;
    }

    private function staleReason(AgentProposal $p): ?string
    {
        $c = $p->campaign;
        $day = $this->campaigns->currentDay($c);
        if ((int) $c->current_day !== (int) $p->day_no) {
            return 'hari kampanye sudah berganti';
        }
        $findings = $this->findings($c, $day, $p->payload);

        return $findings ? implode(' ', $findings) : null;
    }

    private function expire(AgentProposal $p, User $user, string $reason): void
    {
        $p->forceFill(['status' => 'expired', 'decided_at' => now(), 'decision_reason' => Str::limit($reason, 500, '')])->save();
        $this->audit->record('user', (string) $user->id, 'agent.proposal_expired', ['proposal_id' => $p->uuid, 'campaign_id' => $p->campaign_id, 'day' => $p->day_no, 'reason' => $reason]);
    }

    private function lock(AgentProposal $p): AgentProposal
    {
        return AgentProposal::whereKey($p->id)->lockForUpdate()->firstOrFail();
    }

    private function assertStatus(AgentProposal $p, string $expected, string $message): void
    {
        if ($p->status !== $expected) {
            throw ValidationException::withMessages(['status' => $message]);
        }
    }

    private function editable(CampaignDay $day): bool
    {
        return in_array($day->status, ['planned', 'failed'], true);
    }

    /** @return array{asset:string, minute:float, duration_min:float}|null */
    private function payloadOf(mixed $w): ?array
    {
        if (! is_array($w) || ! is_string($w['asset'] ?? null) || ! preg_match('/^TK-(RAW|STO)-\d{1,2}$/', $w['asset'])
            || ! is_numeric($w['minute'] ?? null) || ! is_numeric($w['duration_min'] ?? null)) {
            return null;
        }

        return ['asset' => $w['asset'], 'minute' => round((float) $w['minute'], 1), 'duration_min' => round((float) $w['duration_min'], 1)];
    }
}
