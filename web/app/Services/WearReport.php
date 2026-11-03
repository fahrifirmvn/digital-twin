<?php

namespace App\Services;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/** Fouling sterilizer dan umur simpan produk dari event fouling.expiry (satu per run, dikirim engine di akhir hari). */
class WearReport
{
    /**
     * @return array{fouling:array{limit_min:float, sterilizers:list<array<string,mixed>>, flagged:int}, expiry:array<string,mixed>}|null
     */
    public function forRun(int $runId): ?array
    {
        $row = DB::table('sim_events')->where('run_id', $runId)->where('type', 'fouling.expiry')
            ->orderByDesc('seq')->value('payload');
        $p = $row ? json_decode($row, true) : null;
        if (! is_array($p) || ! isset($p['fouling'], $p['expiry'])) {
            return null;
        }
        foreach ($p['fouling']['sterilizers'] as &$s) {
            $s['reached_clock'] = ($s['reached_at'] ?? null) ? Carbon::parse($s['reached_at'])->utc()->format('H:i') : null;
        }
        unset($s);
        $p['fouling']['flagged'] = count(array_filter($p['fouling']['sterilizers'], fn ($s) => $s['state'] !== 'ok'));

        return ['fouling' => $p['fouling'], 'expiry' => $p['expiry']];
    }
}
