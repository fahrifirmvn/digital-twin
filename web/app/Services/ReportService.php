<?php

namespace App\Services;

use App\Models\SimRun;
use Symfony\Component\HttpFoundation\StreamedResponse;

class ReportService
{
    /** @return array<string, mixed> */
    public function data(SimRun $run): array
    {
        $result = $run->result_payload;
        abort_unless($run->status === 'finished' && is_array($result), 404);

        $kpi = $result['kpi'] ?? [];
        $metrics = [
            ['Truk terjadwal', $kpi['trucks'] ?? null, 'truk'],
            ['Truk selesai', $kpi['completed'] ?? null, 'truk'],
            ['Waktu tunggu rata-rata', data_get($kpi, 'truck_wait_min.mean'), 'menit'],
            ['Waktu tunggu p90', data_get($kpi, 'truck_wait_min.p90'), 'menit'],
            ['Susu diproses', $kpi['raw_ton'] ?? null, 'ton'],
            ['Produk jadi', $kpi['fg_ton'] ?? null, 'ton'],
            ['Tertahan QA', $kpi['held_qa'] ?? null, 'batch'],
            ['False accept', $kpi['false_accept'] ?? null, 'batch'],
            ['Pelanggaran holding', $kpi['holding_violations'] ?? null, 'batch'],
            ['Kepatuhan jadwal', $kpi['schedule_adherence_pct'] ?? null, '%'],
            ['CIP darurat', $kpi['unscheduled_cip'] ?? null, 'kali'],
        ];
        $holds = array_values(array_map(
            fn ($g) => [$g['gate'] ?? '', $g['object_id'] ?? '', $g['reason'] ?? ''],
            array_filter($result['gates'] ?? [], fn ($g) => ($g['decision'] ?? '') !== 'pass'),
        ));
        $tankers = array_values(array_map(fn ($t) => [
            $t['code'] ?? '', $t['farm_code'] ?? '', $t['volume_ton'] ?? null, $t['temp_c'] ?? null,
            $t['lab_results']['pH'] ?? $t['lab_results']['ph'] ?? null, $t['outcome'] ?? '',
        ], $result['tankers'] ?? []));

        return [
            'run_id' => $run->id,
            'kind' => $run->kind,
            'status' => $run->status,
            'config' => $result['config'] ?? '',
            'scenario' => $result['scenario'] ?? '',
            'started' => $result['sim_start'] ?? '',
            'ended' => $result['sim_end'] ?? '',
            'metrics' => $metrics,
            'gate_holds' => $holds,
            'gate_hold_count' => count(array_filter($result['gates'] ?? [], fn ($g) => ($g['decision'] ?? '') !== 'pass')),
            'tankers' => $tankers,
            'tanker_count' => count($result['tankers'] ?? []),
            'transfer_count' => count($result['transfers'] ?? []),
            'cip_count' => count($result['cips'] ?? []),
        ];
    }

    public function csv(SimRun $run, ?array $report = null): StreamedResponse
    {
        $report ??= $this->data($run);
        $filename = $this->filename($run, 'csv');

        return response()->streamDownload(function () use ($report) {
            $out = fopen('php://output', 'wb');
            fwrite($out, "\xEF\xBB\xBF");
            $this->csvRow($out, ['Bagian', 'Parameter', 'Nilai', 'Satuan']);
            foreach ([
                ['Run', 'ID', $report['run_id'], ''],
                ['Run', 'Jenis', $report['kind'], ''],
                ['Run', 'Konfigurasi', $report['config'], ''],
                ['Run', 'Skenario', $report['scenario'], ''],
                ['Run', 'Mulai', $report['started'], ''],
                ['Run', 'Selesai', $report['ended'], ''],
            ] as $row) {
                $this->csvRow($out, $row);
            }
            foreach ($report['metrics'] as [$label, $value, $unit]) {
                $this->csvRow($out, ['KPI', $label, $value ?? '', $unit]);
            }
            $this->csvRow($out, ['KPI', 'Jumlah penahanan gate', $report['gate_hold_count'], 'batch']);
            $this->csvRow($out, ['KPI', 'Jumlah transfer', $report['transfer_count'], 'transfer']);
            $this->csvRow($out, ['KPI', 'Jumlah CIP', $report['cip_count'], 'kali']);
            $this->csvRow($out, ['Truk', 'Kode', 'Peternakan', 'Volume ton', 'Suhu C', 'pH', 'Hasil']);
            foreach ($report['tankers'] as [$code, $farm, $volume, $temp, $ph, $outcome]) {
                $this->csvRow($out, ['Truk', $code, $farm, $volume ?? '', $temp ?? '', $ph ?? '', $outcome]);
            }
            $this->csvRow($out, ['Gate', 'Gate', 'Objek', 'Alasan']);
            foreach ($report['gate_holds'] as [$gate, $object, $reason]) {
                $this->csvRow($out, ['Gate', $gate, $object, $reason]);
            }
            fclose($out);
        }, $filename, ['Content-Type' => 'text/csv; charset=UTF-8']);
    }

    public function filename(SimRun $run, string $extension): string
    {
        return "lactatwin-run-{$run->id}-report.{$extension}";
    }

    /** @param resource $out
     * @param  list<mixed>  $values
     */
    private function csvRow($out, array $values): void
    {
        $safe = array_map(fn ($value) => is_string($value) && preg_match('/^[\t\r ]*[=+\-@]/', $value) ? "'".$value : $value, $values);
        fputcsv($out, $safe);
    }
}
