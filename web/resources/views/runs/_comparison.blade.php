@php
    $rows = [
        ['Tunggu truk, rata-rata (mnt)', fn ($k) => $k['truck_wait_min']['mean'] ?? null],
        ['Tunggu truk, P90 (mnt)', fn ($k) => $k['truck_wait_min']['p90'] ?? null],
        ['Tunggu lab, rata-rata (mnt)', fn ($k) => $k['lab_wait_min']['mean'] ?? null],
        ['Dwell tangki, rata-rata (mnt)', fn ($k) => $k['tank_dwell_min']['mean'] ?? null],
        ['Changeover (kali)', fn ($k) => $k['changeover_count'] ?? null],
        ['Changeover (menit)', fn ($k) => $k['changeover_min'] ?? null],
        ['CIP darurat', fn ($k) => $k['unscheduled_cip'] ?? null],
        ['FG keluar (L)', fn ($k) => isset($k['fg_ton']) ? \App\Support\Volume::liters($k['fg_ton']) : null],
        ['Pelanggaran holding', fn ($k) => $k['holding_violations'] ?? null],
        ['False accept', fn ($k) => $k['false_accept'] ?? null],
    ];
    $base = $comparison['A']['kpi'] ?? null;
@endphp
<div class="card" id="comparison">
    <h3>Perbandingan konfigurasi (hari yang sama)</h3>
    <p class="muted">Seed, volume, dan truk di luar batas mutu sama. Run terbaru per konfigurasi. Selisih terhadap A dalam kurung.</p>
    <table>
        <thead>
            <tr><th>KPI</th>@foreach ($comparison as $cfg => $c)<th>{{ $cfg }} <a href="{{ route('runs.show', $c['id']) }}">#{{ $c['id'] }}</a></th>@endforeach</tr>
        </thead>
        <tbody>
        @foreach ($rows as [$label, $get])
            <tr>
                <td>{{ $label }}</td>
                @foreach ($comparison as $cfg => $c)
                    @php($v = $get($c['kpi']))
                    @php($b = $base ? $get($base) : null)
                    <td>{{ $v ?? '-' }}@if ($cfg !== 'A' && $v !== null && $b !== null && $v != $b) <small>({{ $v - $b > 0 ? '+' : '' }}{{ round($v - $b, 1) }})</small>@endif</td>
                @endforeach
            </tr>
        @endforeach
        </tbody>
    </table>
</div>
