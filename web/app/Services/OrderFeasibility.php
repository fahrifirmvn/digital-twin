<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/** Order produksi dan "dapat dipenuhi?" dari event orders.evaluated (satu per run, dikirim engine di akhir hari). */
class OrderFeasibility
{
    /**
     * @return array<string, mixed>|null
     */
    public function forRun(int $runId): ?array
    {
        $row = DB::table('sim_events')->where('run_id', $runId)->where('type', 'orders.evaluated')
            ->orderByDesc('seq')->value('payload');
        $p = $row ? json_decode($row, true) : null;
        if (! is_array($p) || ! isset($p['orders'])) {
            return null;
        }
        $fullPct = (float) ($p['milk_use_full_pct'] ?? 100.0);
        $flavPct = (float) ($p['milk_use_flavour_pct'] ?? 90.0);

        foreach ($p['orders'] as &$o) {
            $sku = (string) ($o['sku'] ?? '');
            $isFlavour = str_contains($sku, 'CHOC') || str_contains($sku, 'STRW');
            $o['milk_ratio_pct'] = $isFlavour ? $flavPct : $fullPct;
            $o['fill_hours_est'] = round(((float) ($o['ordered_ton'] ?? 0)) / 10.0, 1);
            if ($o['feasible'] ?? false) {
                $o['recommendation'] = 'Terpenuhi penuh sesuai alokasi susu & kapasitas lini.';
            } else {
                $topCause = $o['causes'][0]['code'] ?? 'supply';
                $o['recommendation'] = match ($topCause) {
                    'gate' => 'Susu berkurang di G1/G2 — alihkan cadangan tangki atau uji ulang alokasi order.',
                    'qa' => 'Batch ditahan QA (G4/G5) — tinjau keputusan QA atau percepat jadwal sterilisasi.',
                    'unfinished' => 'Jam pengisian tidak cukup — kurangi changeover atau sesuaikan aliran lini.',
                    default => 'Pasokan susu SKU ini kurang — sesuaikan order di Parameter Operasional untuk realokasi truk.',
                };
            }
        }
        unset($o);

        $p['met'] = count(array_filter($p['orders'], fn ($o) => $o['feasible'] ?? false));
        $p['total_ordered_ton'] = round(array_sum(array_map(fn ($o) => (float) ($o['ordered_ton'] ?? 0), $p['orders'])), 2);
        $p['total_fulfilled_ton'] = round(array_sum(array_map(fn ($o) => (float) ($o['fulfilled_ton'] ?? 0), $p['orders'])), 2);
        $p['total_milk_needed_ton'] = round(array_sum(array_map(fn ($o) => (float) ($o['milk_needed_ton'] ?? 0), $p['orders'])), 2);
        $p['total_milk_used_ton'] = round(array_sum(array_map(fn ($o) => (float) ($o['milk_used_ton'] ?? 0), $p['orders'])), 2);

        return $p;
    }
}
