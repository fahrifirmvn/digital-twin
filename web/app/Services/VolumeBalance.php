<?php

namespace App\Services;

use App\Support\Volume;
use Illuminate\Support\Facades\DB;

/** Neraca volume dari event volume.balance (satu per run, dikirim engine di akhir hari). Satuan ton; liter hanya konversi tampilan. */
class VolumeBalance
{
    public const LITRE_PER_TON = Volume::L_PER_TON;

    /**
     * @return array{in: list<array{label:string, ton:float}>, out: list<array{label:string, ton:float}>, in_total:float, out_total:float, balanced:bool, not_received_ton:float}|null
     */
    public function forRun(int $runId): ?array
    {
        $row = DB::table('sim_events')->where('run_id', $runId)->where('type', 'volume.balance')
            ->orderByDesc('seq')->value('payload');
        $p = $row ? json_decode($row, true) : null;
        if (! is_array($p) || ! isset($p['received_ton'])) {
            return null;
        }
        $in = [
            ['label' => 'Stok awal tangki', 'ton' => (float) $p['opening_stock_ton']],
            ['label' => 'Susu diterima (selesai bongkar)', 'ton' => (float) $p['received_ton']],
        ];
        $out = [
            ['label' => 'Produk jadi (FG) keluar', 'ton' => (float) $p['fg_ton']],
            ['label' => 'Susut proses (separator dan filling)', 'ton' => (float) $p['loss_ton']],
            ['label' => 'Ditahan QA', 'ton' => (float) $p['qa_hold_ton']],
            ['label' => 'Sisa di tangki akhir hari', 'ton' => (float) $p['tank_end_ton'] + (float) $p['opening_stock_ton']],
            ['label' => 'Masih dalam proses', 'ton' => (float) $p['in_process_ton']],
        ];
        $in_total = array_sum(array_column($in, 'ton'));
        $out_total = array_sum(array_column($out, 'ton'));

        return [
            'in' => $in, 'out' => $out, 'in_total' => $in_total, 'out_total' => $out_total,
            'balanced' => abs($in_total - $out_total) < 0.05,
            'not_received_ton' => (float) $p['not_received_ton'],
        ];
    }
}
