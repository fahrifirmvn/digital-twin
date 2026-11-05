<?php

namespace App\Http\Controllers;

use App\Models\SimRun;
use App\Services\AuditLogger;
use App\Services\ReportService;
use Barryvdh\DomPDF\Facade\Pdf;
use Illuminate\Http\Request;
use PhpOffice\PhpWord\IOFactory;
use PhpOffice\PhpWord\PhpWord;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

class ReportController extends Controller
{
    public function download(Request $request, SimRun $run, string $format, ReportService $reports, AuditLogger $audit): Response|BinaryFileResponse|StreamedResponse
    {
        abort_unless(in_array($format, ['csv', 'pdf', 'docx'], true), 404);
        $data = $reports->data($run);
        $filename = $reports->filename($run, $format);
        $user = $request->user();
        $audit->record('user', (string) $user->id, 'report.exported', [
            'run_id' => $run->id,
            'format' => $format,
        ]);

        if ($format === 'csv') {
            return $reports->csv($run, $data);
        }
        if ($format === 'pdf') {
            return Pdf::loadView('reports.run', ['report' => $data])->setPaper('a4')->download($filename);
        }

        $word = new PhpWord;
        $section = $word->addSection();
        $section->addTitle("Laporan Operasi #{$run->id}", 1);
        $section->addText("Konfigurasi {$data['config']} | Skenario {$data['scenario']}");
        $section->addText("Periode: {$data['started']} sampai {$data['ended']}");
        $section->addTitle('Indikator kinerja', 2);
        $table = $section->addTable(['borderSize' => 6, 'borderColor' => 'D7DEE8', 'cellMargin' => 80]);
        foreach ($data['metrics'] as [$label, $value, $unit]) {
            $table->addRow();
            $table->addCell(4600)->addText($label);
            $table->addCell(1800)->addText($value === null ? '-' : (string) $value);
            $table->addCell(1600)->addText($unit);
        }
        $section->addText("Truk: {$data['tanker_count']} | Penahanan gate: {$data['gate_hold_count']} | Transfer: {$data['transfer_count']} | CIP: {$data['cip_count']}");
        $section->addTitle('Penahanan gate', 2);
        foreach ($data['gate_holds'] as [$gate, $object, $reason]) {
            $section->addListItem(trim("{$gate} | {$object} | {$reason}", ' |'));
        }
        $section->addTitle('Truk', 2);
        $tankers = $section->addTable(['borderSize' => 6, 'borderColor' => 'D7DEE8', 'cellMargin' => 60]);
        $tankers->addRow();
        foreach (['Kode', 'Peternakan', 'Volume ton', 'Suhu C', 'pH', 'Hasil'] as $heading) {
            $tankers->addCell(1500)->addText($heading);
        }
        foreach ($data['tankers'] as [$code, $farm, $volume, $temp, $ph, $outcome]) {
            $tankers->addRow();
            foreach ([$code, $farm, $volume ?? '-', $temp ?? '-', $ph ?? '-', $outcome] as $value) {
                $tankers->addCell(1500)->addText((string) $value);
            }
        }
        $path = tempnam(sys_get_temp_dir(), 'lactatwin-report-');
        IOFactory::createWriter($word, 'Word2007')->save($path);

        return response()->download($path, $filename)->deleteFileAfterSend(true);
    }
}
