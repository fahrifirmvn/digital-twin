<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <title>Laporan Operasi #{{ $report['run_id'] }}</title>
    <style>
        @page { margin: 28px; }
        body { color: #17212b; font-family: DejaVu Sans, sans-serif; font-size: 11px; }
        h1 { color: #14566b; font-size: 22px; margin-bottom: 4px; }
        h2 { border-bottom: 1px solid #d7dee8; font-size: 14px; margin: 22px 0 8px; padding-bottom: 5px; }
        p { color: #536171; margin: 3px 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #d7dee8; padding: 6px 8px; text-align: left; }
        th { background: #e8f1f3; color: #174b58; }
        .meta { margin-bottom: 20px; }
        .num { text-align: right; }
    </style>
</head>
<body>
    <h1>Laporan Operasi #{{ $report['run_id'] }}</h1>
    <div class="meta">
        <p>Konfigurasi {{ $report['config'] }} | Skenario {{ $report['scenario'] }}</p>
        <p>Periode: {{ $report['started'] }} sampai {{ $report['ended'] }}</p>
        <p>{{ $report['tanker_count'] }} truk | {{ $report['gate_hold_count'] }} penahanan gate | {{ $report['transfer_count'] }} transfer | {{ $report['cip_count'] }} CIP</p>
    </div>
    <h2>Indikator kinerja</h2>
    <table>
        <thead><tr><th>Indikator</th><th class="num">Nilai</th><th>Satuan</th></tr></thead>
        <tbody>
            @foreach ($report['metrics'] as [$label, $value, $unit])
                <tr><td>{{ $label }}</td><td class="num">{{ $value ?? '-' }}</td><td>{{ $unit }}</td></tr>
            @endforeach
        </tbody>
    </table>
    <h2>Penahanan gate</h2>
    <table>
        <thead><tr><th>Gate</th><th>Objek</th><th>Alasan</th></tr></thead>
        <tbody>
            @forelse ($report['gate_holds'] as [$gate, $object, $reason])
                <tr><td>{{ $gate }}</td><td>{{ $object }}</td><td>{{ $reason ?: '-' }}</td></tr>
            @empty
                <tr><td colspan="3">Tidak ada penahanan gate.</td></tr>
            @endforelse
        </tbody>
    </table>
    <h2>Truk</h2>
    <table>
        <thead><tr><th>Kode</th><th>Peternakan</th><th>Volume (ton)</th><th>Suhu (C)</th><th>pH</th><th>Hasil</th></tr></thead>
        <tbody>
            @foreach ($report['tankers'] as [$code, $farm, $volume, $temp, $ph, $outcome])
                <tr><td>{{ $code }}</td><td>{{ $farm }}</td><td>{{ $volume ?? '-' }}</td><td>{{ $temp ?? '-' }}</td><td>{{ $ph ?? '-' }}</td><td>{{ $outcome }}</td></tr>
            @endforeach
        </tbody>
    </table>
</body>
</html>
