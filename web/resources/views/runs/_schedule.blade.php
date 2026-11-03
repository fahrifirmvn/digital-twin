@php
    $mc = $versions->first()->kpi_predicted ?? null;
    $kpiLabels = [
        'truck_wait_mean_min' => 'Tunggu truk rata-rata (mnt)',
        'tank_dwell_mean_min' => 'Dwell tangki rata-rata (mnt)',
        'changeover_min' => 'Changeover (mnt)',
        'fg_ton' => 'FG keluar (L)',
        'holding_violations' => 'Pelanggaran holding',
        'schedule_adherence_pct' => 'Kepatuhan jadwal (%)',
        'cost' => 'Biaya rencana',
    ];
@endphp
<div class="card" id="schedule">
    <h3>Rencana jadwal</h3>
    <p class="muted">Optimizer hanya mengusulkan; keputusan release tetap dari gate G1-G6. Data sintetis.</p>
    <table>
        <thead><tr><th>Versi</th><th>Status</th><th>Dibuat oleh</th><th>Truk</th><th>Persetujuan</th></tr></thead>
        <tbody>
        @foreach ($versions as $v)
            <tr>
                <td>v{{ $v->version }}</td>
                <td>{{ $v->status }}</td>
                <td>{{ $v->created_by }}</td>
                <td>{{ count($v->plan['trucks'] ?? []) }}</td>
                <td>
                    @if ($v->status === 'active')
                        <span class="ok">aktif</span>
                    @elseif (in_array($v->status, ['proposed', 'superseded'], true))
                        @can('approve-schedule')
                            <button type="button" data-approve data-run="{{ $run->id }}" data-version="{{ $v->version }}">Setujui</button>
                        @endcan
                    @endif
                </td>
            </tr>
        @endforeach
        </tbody>
    </table>

    @if ($mc)
        <h4>Seleksi Monte Carlo ({{ $mc['samples'] }} sampel skenario)</h4>
        <p>Kandidat terpilih: <strong>{{ $mc['chosen'] }}</strong>. Skor = 0,5 x rata-rata biaya + 0,5 x CVaR80.</p>
        <table>
            <thead><tr><th>Kandidat</th><th>Status</th><th>Rata-rata biaya</th><th>CVaR80</th><th>Skor</th></tr></thead>
            <tbody>
            @foreach ($mc['candidates'] as $c)
                <tr @class(['ok' => $c['label'] === $mc['chosen']])>
                    <td>{{ $c['label'] }}</td><td>{{ $c['status'] }}</td>
                    <td>{{ $c['mean_cost'] }}</td><td>{{ $c['cvar80_cost'] }}</td><td>{{ $c['score'] }}</td>
                </tr>
            @endforeach
            </tbody>
        </table>
        <h4>Prediksi KPI (kandidat terpilih)</h4>
        <table>
            <thead><tr><th>KPI</th><th>Rata-rata</th><th>P10</th><th>P90</th></tr></thead>
            <tbody>
            @foreach ($mc['kpi_predicted'] as $k => $q)
                <tr><td>{{ $kpiLabels[$k] ?? $k }}</td>@php($cv = fn ($v) => $k === 'fg_ton' ? \App\Support\Volume::liters($v) : $v)<td>{{ $cv($q['mean']) }}</td><td>{{ $cv($q['p10']) }}</td><td>{{ $cv($q['p90']) }}</td></tr>
            @endforeach
            </tbody>
        </table>
    @endif

    @if ($replans->isNotEmpty())
        <h4>Re-optimization bergulir ({{ $replans->count() }}x)</h4>
        <table>
            <thead><tr><th>Waktu sim</th><th>Versi</th><th>Pemicu</th><th>Status</th><th>Truk</th><th>Objektif</th></tr></thead>
            <tbody>
            @foreach ($replans as $p)
                <tr @class(['err' => ($p['status'] ?? '') === 'failed'])>
                    <td>{{ \Illuminate\Support\Carbon::parse($p['at'])->utc()->format('H:i') }}</td>
                    <td>v{{ $p['version'] }}</td><td>{{ $p['trigger'] }}</td><td>{{ $p['status'] }}</td>
                    <td>{{ $p['trucks'] }}</td><td>{{ $p['objective'] ?? '-' }}</td>
                </tr>
            @endforeach
            </tbody>
        </table>
    @endif
</div>
