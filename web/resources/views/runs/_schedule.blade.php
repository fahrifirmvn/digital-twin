@php
    $mc = $versions->first()->kpi_predicted ?? null;
    $activeVer = $versions->firstWhere('status', 'active') ?? $versions->first();
    $activeTrucks = $activeVer?->plan['trucks'] ?? [];
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
    <p class="muted">Optimizer hanya mengusulkan; keputusan release tetap dari gate G1-G6.</p>
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

    @if (! empty($activeTrucks))
        @php
            $lastOnBay = [];
            $lastOnLine = [];
        @endphp
        <details class="dash-note" style="margin-top: 12px;">
            <summary>Rincian penugasan, pembatas aktif &amp; margin holding G4 per truk (v{{ $activeVer->version }} · {{ count($activeTrucks) }} truk)</summary>
            <table>
                <thead>
                    <tr>
                        <th>Truk</th>
                        <th>Bay</th>
                        <th>Sterilizer</th>
                        <th>Filling line</th>
                        <th>Mulai bongkar</th>
                        <th>Mulai sterilisasi</th>
                        <th>Mulai isi</th>
                        <th>Est. dwell (mnt)</th>
                        <th>Sisa margin G4 (240 mnt)</th>
                        <th>Alasan penjadwalan</th>
                    </tr>
                </thead>
                <tbody>
                @foreach ($activeTrucks as $tp)
                    @php
                        $unlMin = isset($tp['unload_start']) ? \Illuminate\Support\Carbon::parse($tp['unload_start'])->utc()->format('H:i') : '-';
                        $steMin = isset($tp['ster_start']) ? \Illuminate\Support\Carbon::parse($tp['ster_start'])->utc()->format('H:i') : '-';
                        $filMin = isset($tp['fill_start']) ? \Illuminate\Support\Carbon::parse($tp['fill_start'])->utc()->format('H:i') : '-';
                        $dwellEst = (isset($tp['unload_start'], $tp['ster_start']))
                            ? max(0, round(\Illuminate\Support\Carbon::parse($tp['unload_start'])->diffInMinutes(\Illuminate\Support\Carbon::parse($tp['ster_start'])) - 40))
                            : null;
                        $slackEst = $dwellEst !== null ? 240 - $dwellEst : null;
                        $bayCode = $tp['bay'] ?? '-';
                        $lineCode = $tp['line'] ?? '-';
                        $prevBayTruck = $lastOnBay[$bayCode] ?? null;
                        $prevLineTruck = $lastOnLine[$lineCode] ?? null;
                        $reasons = [];
                        if ($slackEst !== null && $slackEst <= 45) {
                            $reasons[] = 'Jaga batas holding G4';
                        }
                        $reasons[] = $prevBayTruck ? "Antre {$bayCode} setelah {$prevBayTruck}" : "Slot awal {$bayCode} pasca-G2";
                        if ($prevLineTruck) {
                            $reasons[] = "Urutan {$lineCode} setelah {$prevLineTruck}";
                        }
                        $bindingText = implode(' · ', $reasons);
                        $lastOnBay[$bayCode] = $tp['code'] ?? null;
                        $lastOnLine[$lineCode] = $tp['code'] ?? null;
                    @endphp
                    <tr>
                        <td class="mono">{{ $tp['code'] }}</td>
                        <td class="mono">{{ $tp['bay'] }}</td>
                        <td class="mono">{{ $tp['sterilizer'] }}</td>
                        <td class="mono">{{ $tp['line'] }}</td>
                        <td class="mono">{{ $unlMin }}</td>
                        <td class="mono">{{ $steMin }}</td>
                        <td class="mono">{{ $filMin }}</td>
                        <td>{{ $dwellEst !== null ? $dwellEst.' mnt' : '-' }}</td>
                        <td>
                            @if ($slackEst !== null)
                                <span class="{{ $slackEst >= 45 ? 'ok' : 'err' }}">+{{ $slackEst }} mnt</span>
                            @else
                                -
                            @endif
                        </td>
                        <td><small>{{ $bindingText }}</small></td>
                    </tr>
                @endforeach
                </tbody>
            </table>
        </details>
    @endif

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
            @php
                $cv = fn ($k, $v) => $k === 'fg_ton' ? \App\Support\Volume::liters($v) : $v;
            @endphp
            @foreach ($mc['kpi_predicted'] as $k => $q)
                <tr><td>{{ $kpiLabels[$k] ?? $k }}</td><td>{{ $cv($k, $q['mean']) }}</td><td>{{ $cv($k, $q['p10']) }}</td><td>{{ $cv($k, $q['p90']) }}</td></tr>
            @endforeach
            </tbody>
        </table>
    @endif

    @if ($replans->isNotEmpty())
        @php
            $prevMap = collect($run->day_result['plan']['trucks'] ?? [])->keyBy('code')->all();
        @endphp
        <h4>Re-optimization bergulir ({{ $replans->count() }}x)</h4>
        <table>
            <thead><tr><th>Waktu sim</th><th>Versi</th><th>Pemicu</th><th>Status</th><th>Truk</th><th>Perubahan rute</th><th>Objektif</th></tr></thead>
            <tbody>
            @foreach ($replans as $p)
                @php
                    $changedCount = 0;
                    foreach ($p['plan']['trucks'] ?? [] as $rtp) {
                        $oldTp = $prevMap[$rtp['code']] ?? null;
                        if ($oldTp && (($oldTp['bay'] ?? null) !== ($rtp['bay'] ?? null) || ($oldTp['sterilizer'] ?? null) !== ($rtp['sterilizer'] ?? null) || ($oldTp['line'] ?? null) !== ($rtp['line'] ?? null))) {
                            $changedCount++;
                        }
                        $prevMap[$rtp['code']] = $rtp;
                    }
                @endphp
                <tr @class(['err' => ($p['status'] ?? '') === 'failed'])>
                    <td>{{ \Illuminate\Support\Carbon::parse($p['at'])->utc()->format('H:i') }}</td>
                    <td>v{{ $p['version'] }}</td><td>{{ $p['trigger'] }}</td><td>{{ $p['status'] }}</td>
                    <td>{{ $p['trucks'] }}</td>
                    <td>{{ ($p['status'] ?? '') === 'failed' ? '-' : $changedCount.' truk' }}</td>
                    <td>{{ $p['objective'] ?? '-' }}</td>
                </tr>
            @endforeach
            </tbody>
        </table>
    @endif
</div>
