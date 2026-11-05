<?php

namespace App\Services;

use App\Support\Volume;
use Illuminate\Support\Facades\DB;

/** Neraca volume dari event volume.balance (satu per run, dikirim engine di akhir hari). Satuan ton; liter hanya konversi tampilan. */
class VolumeBalance
{
    public const LITRE_PER_TON = Volume::L_PER_TON;

    /**
     * @return array<string, mixed>|null
     */
    public function forRun(int $runId): ?array
    {
        $row = DB::table('sim_events')->where('run_id', $runId)->where('type', 'volume.balance')
            ->orderByDesc('seq')->value('payload');
        $p = $row ? json_decode($row, true) : null;
        if (! is_array($p) || ! isset($p['received_ton'])) {
            return null;
        }
        $opening = (float) $p['opening_stock_ton'];
        $received = (float) $p['received_ton'];
        $fg = (float) $p['fg_ton'];
        $loss = (float) $p['loss_ton'];
        $lossSep = isset($p['loss_therm_sep_ton']) ? (float) $p['loss_therm_sep_ton'] : round($loss / 2, 2);
        $lossFill = round($loss - $lossSep, 2);
        $qaHold = (float) $p['qa_hold_ton'];
        $tankNewEnd = (float) $p['tank_end_ton'];
        $inProcess = (float) $p['in_process_ton'];
        $closingStock = round($opening + $tankNewEnd, 2);

        $in = [
            ['label' => 'Stok awal tangki (06:00 WIB)', 'ton' => $opening],
            ['label' => 'Susu diterima (selesai bongkar)', 'ton' => $received],
        ];
        $out = [
            ['label' => 'Produk jadi (FG) keluar', 'ton' => $fg],
            ['label' => 'Susut termisasi & separator', 'ton' => $lossSep],
            ['label' => 'Susut pengisian (filling)', 'ton' => $lossFill],
            ['label' => 'Ditahan QA (G5)', 'ton' => $qaHold],
            ['label' => 'Sisa susu baru di tangki akhir hari', 'ton' => $tankNewEnd],
            ['label' => 'Stok awal tangki (terbawa akhir hari)', 'ton' => $opening],
            ['label' => 'Masih dalam proses', 'ton' => $inProcess],
        ];
        $in_total = round(array_sum(array_column($in, 'ton')), 4);
        $out_total = round(array_sum(array_column($out, 'ton')), 4);
        $residual = round($in_total - $out_total, 4);
        if (abs($residual) < 1e-4) {
            $residual = 0.0;
        }

        return [
            'in' => $in,
            'out' => $out,
            'in_total' => $in_total,
            'out_total' => $out_total,
            'balanced' => abs($residual) < 0.05,
            'residual_ton' => $residual,
            'opening_stock_ton' => $opening,
            'received_ton' => $received,
            'fg_ton' => $fg,
            'loss_ton' => $loss,
            'loss_sep_ton' => $lossSep,
            'loss_fill_ton' => $lossFill,
            'qa_hold_ton' => $qaHold,
            'tank_new_end_ton' => $tankNewEnd,
            'closing_stock_ton' => $closingStock,
            'in_process_ton' => $inProcess,
            'not_received_ton' => (float) $p['not_received_ton'],
            'yield_pct' => $received > 0 ? round(100.0 * $fg / $received, 1) : 0.0,
        ];
    }
}
