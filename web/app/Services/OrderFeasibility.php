<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/** Order produksi dan "dapat dipenuhi?" dari event orders.evaluated (satu per run, dikirim engine di akhir hari). */
class OrderFeasibility
{
    /**
     * @return array{source:string, milk_use_full_pct:float, milk_use_flavour_pct:float, orders:list<array<string,mixed>>, met:int}|null
     */
    public function forRun(int $runId): ?array
    {
        $row = DB::table('sim_events')->where('run_id', $runId)->where('type', 'orders.evaluated')
            ->orderByDesc('seq')->value('payload');
        $p = $row ? json_decode($row, true) : null;
        if (! is_array($p) || ! isset($p['orders'])) {
            return null;
        }
        $p['met'] = count(array_filter($p['orders'], fn ($o) => $o['feasible'] ?? false));

        return $p;
    }
}
