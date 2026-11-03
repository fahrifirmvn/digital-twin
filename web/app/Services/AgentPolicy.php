<?php

namespace App\Services;

// Kebijakan deterministik Agen Copilot: dari pengamatan pada satu menit, hasilnya daftar perintah kandidat.
// Murni, tanpa DB. Hanya dua jenis yang pernah dihasilkan: setujui usulan sistem dan (tingkat 3) tahan truk di gerbang.
// Gate SOP, ambang mutu, dan rilis tidak pernah muncul di sini.
final class AgentPolicy
{
    /** Satu-satunya jenis perintah yang boleh diusulkan agen. */
    public const KINDS = ['plan_approve', 'truck_hold'];

    /**
     * @param  list<array{code:string, since:float}>  $waiting  Truk antre lab/bay yang punya baris di rencana
     * @param  list<array{code:string, eta:float}>  $inbound  Truk menuju gerbang (belum tiba)
     * @param  list<array{0:float, 1:float}>  $outages  Jendela sterilizer mati [mulai, selesai] dalam menit
     * @return list<array{kind:string, args:array<string,mixed>, reason:string}>
     */
    public static function candidates(int $level, int $limit, array $waiting, array $inbound, array $outages, int $holdMinutes): array
    {
        if ($level < 1 || $limit < 1) {
            return [];
        }

        usort($waiting, fn ($a, $b) => [$a['since'], $a['code']] <=> [$b['since'], $b['code']]);
        $out = [];
        foreach ($waiting as $t) {
            $out[] = ['kind' => 'plan_approve', 'args' => ['truck' => $t['code']], 'reason' => "Agen: usulan sistem untuk {$t['code']} sesuai kapasitas"];
        }

        if ($level >= 3) {
            usort($inbound, fn ($a, $b) => [$a['eta'], $a['code']] <=> [$b['eta'], $b['code']]);
            foreach ($inbound as $t) {
                foreach ($outages as [$from, $to]) {
                    if ($t['eta'] >= $from && $t['eta'] <= $to) {
                        $out[] = ['kind' => 'truck_hold', 'args' => ['truck' => $t['code'], 'duration_min' => $holdMinutes], 'reason' => "Agen: sterilizer mati saat {$t['code']} tiba"];
                        break;
                    }
                }
            }
        }

        return array_slice($out, 0, $limit);
    }

    /**
     * Putusan verifikasi cabang kandidat terhadap run asalnya: sama dengan skor latihan PPIC (P5).
     * Gagal bila ada upaya menembus gate; lulus bila tunggu rata-rata tidak lebih buruk.
     *
     * @param  list<array<string,mixed>>  $commandEvents  Payload event `command.applied` cabang kandidat
     * @return array{verdict:string, mean:?float, base:?float, delta:?float, violations:int}
     */
    public static function verdict(?array $kpi, ?array $baseKpi, array $commandEvents): array
    {
        $mean = $kpi['truck_wait_min']['mean'] ?? null;
        $base = $baseKpi['truck_wait_min']['mean'] ?? null;
        $violations = count(array_filter($commandEvents, fn ($p) => ! empty($p['blocked']) && ! empty($p['gate'])));
        if (! is_numeric($mean) || ! is_numeric($base)) {
            return ['verdict' => $violations ? 'gagal' : 'tanpa_data', 'mean' => null, 'base' => null, 'delta' => null, 'violations' => $violations];
        }
        $mean = round((float) $mean, 1);
        $base = round((float) $base, 1);
        $delta = round($mean - $base, 1);

        return ['verdict' => $violations ? 'gagal' : ($delta <= 0 ? 'lulus' : 'belum'), 'mean' => $mean, 'base' => $base, 'delta' => $delta, 'violations' => $violations];
    }
}
