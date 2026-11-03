@php
    $an = $ai['anomaly'];
    $risky = collect($ai['trucks'])->sortBy('qc_release_prob')->take(8);
    $flagLabels = [
        'MASS_BALANCE_RESIDUAL_HIGH' => 'Residual neraca tinggi',
        'HOLDING_TIME_EXCEEDED' => 'Holding time terlampaui',
        'FLOW_RATE_ANOMALY' => 'Laju alir menyimpang',
    ];
@endphp
<section id="ai-panel" class="tw-card" aria-labelledby="h-ai">
    <h2 id="h-ai">Prediksi AI <span class="tw-badge" title="Model dilatih pada data sintetis, bukan data pabrik">{{ $ai['label'] }}</span></h2>
    <p class="tw-hint">Model hanya memprediksi. Keputusan tetap dari gate dan penjadwal CP-SAT.</p>

    <h3>Anomali pabrik</h3>
    <p id="ai-anomaly" data-anomaly="{{ $an['is_anomaly'] ? '1' : '0' }}">
        Skor risiko <strong>{{ number_format($an['risk_score'] * 100, 0) }}%</strong>,
        {{ $an['is_anomaly'] ? 'ada anomali' : 'normal' }}.
        Residual neraca {{ $an['balance_residual_l'] }} L, umur batch terlama {{ $an['batch_age_h'] }} jam,
        simpangan laju bongkar {{ $an['flow_deviation_pct'] }}%.
    </p>
    @if (count($an['flags'] ?? []) > 0)
        <ul class="plain">
            @foreach ($an['flags'] ?? [] as $f)
                <li>{{ $flagLabels[$f] ?? $f }}</li>
            @endforeach
        </ul>
    @endif

    <h3>Truk dengan peluang lolos QC terendah</h3>
    <table>
        <thead>
            <tr><th>Truk</th><th>Keterlambatan P50/P80/P90 (mnt)</th><th>Lab P50/P90 (mnt)</th><th>Lolos QC</th></tr>
        </thead>
        <tbody>
        @foreach ($risky as $t)
            <tr>
                <td>{{ $t['code'] }}</td>
                <td>{{ round($t['delay_p50_min']) }} / {{ round($t['delay_p80_min']) }} / {{ round($t['delay_p90_min']) }}</td>
                <td>{{ round($t['lab_p50_min']) }} / {{ round($t['lab_p90_min']) }}</td>
                <td>{{ number_format($t['qc_release_prob'] * 100, 1) }}%</td>
            </tr>
        @endforeach
        </tbody>
    </table>
    <p class="tw-hint">Model: {{ collect($ai['models'])->map(fn ($h, $n) => $n.' ('.$h.')')->implode(', ') }}.</p>
</section>
