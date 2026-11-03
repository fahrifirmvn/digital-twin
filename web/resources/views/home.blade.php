@extends('layouts.app')
@section('title', "Dashboard Run #{$run->id} | LactaTwin")
@section('bare', '1')

@push('head')
@vite('resources/js/home.js')
@endpush

@push('topbar-tools')
    <button id="cp-open" class="tw-btn primary" type="button" data-icon="sparkles" data-icon-size="18" aria-controls="cp-drawer" aria-expanded="false"><span>Tanya Asisten AI</span></button>
@endpush

@section('content')
@php
    $q = ['run' => $run->id];
    $fmt = fn ($v, $d = 1) => $v === null ? '-' : number_format((float) $v, $d, ',', '.');
    $holds = $kpi ? array_sum($kpi['gate_holds'] ?? []) : null;
    $chips = [
        ['Truk hari ini', $kpi['trucks'] ?? null, 0, 'terjadwal dan dadakan'],
        ['Selesai bongkar', isset($kpi) ? ($kpi['completed'] + $kpi['held_qa']) : null, 0, 'termasuk ditahan QA'],
        ['FG keluar', isset($kpi['fg_ton']) ? \App\Support\Volume::liters($kpi['fg_ton']) : null, 0, 'liter'],
        ['Tunggu truk', $kpi['truck_wait_min']['mean'] ?? null, 1, 'menit, rata-rata'],
        ['Gate menahan', $holds, 0, 'G1 sampai G6'],
        ['False accept', $kpi['false_accept'] ?? null, 0, 'target 0'],
    ];
@endphp
<div id="tw" class="tw tw-dash" data-theme="light" @if ($kpi) data-replay-url="{{ route('runs.replay', $run) }}" data-run-id="{{ $run->id }}" @endif>
    @include('runs._topbar', ['active' => 'dashboard', 'staticStatus' => $run->status])

    <main class="dash">
        <div class="dash-head">
            <div>
                <h1>Dashboard</h1>
                <p class="muted">
                    Konfigurasi {{ $run->config_snapshot['config'] ?? 'A' }}
                    ({{ config('twin.configs')[$run->config_snapshot['config'] ?? 'A'] ?? '' }}).
                    Skenario: {{ config('twin.scenarios')[$run->config_snapshot['scenario'] ?? 'normal'] ?? '-' }}.
                    Seed {{ $run->seed }}, {{ isset($run->config_snapshot['params']['volume_ton']) ? \App\Support\Volume::l($run->config_snapshot['params']['volume_ton']) : '?' }}/hari.
                </p>
            </div>
            <a class="tw-btn" href="{{ route('runs.show', $run) }}" data-icon="dashboard" data-icon-size="18"><span>Monitoring dan What-if</span></a>
        </div>

        @if (session('status'))
            <div class="tw-card ok" role="status">{{ session('status') }}</div>
        @endif
        @include('runs._params')

        @if (! $kpi)
            <div class="tw-card" role="status"><p class="muted">Run ini belum selesai, jadi ringkasan dan jadwal belum tersedia. Digital Twin dan Maps akan terisi setelah run selesai.</p></div>
        @endif

        @if ($kpi)
            <nav class="dash-nav" aria-label="Bagian dashboard">
                <a href="#s-ord">Order</a><a href="#h-bal">Neraca</a><a href="#h-hold">Holding</a><a href="#h-wear">Fouling</a><a href="#h-sched">Jadwal</a>
            </nav>
        @endif

        <section class="dash-kpis" aria-label="Ringkasan hari ini">
            @foreach ($chips as [$label, $value, $dec, $note])
                <div class="tw-card kpi"><span>{{ $label }}</span><b>{{ $fmt($value, $dec) }}</b><small>{{ $note }}</small></div>
            @endforeach
        </section>

        <section class="dash-tiles" aria-label="Tampilan layar penuh">
            <a class="tw-card tw-tile" href="{{ route('twin', $q) }}">
                <span class="tw-tile-ico" data-icon="box" data-icon-size="28"></span>
                <h2>Digital Twin</h2>
                <p class="muted">Denah pabrik dengan truk, bay, silo, dan gate SOP. Putar ulang run menit demi menit.</p>
                @if ($kpi)
                    <canvas id="mini-twin" class="tw-mini" aria-hidden="true"></canvas>
                    <span class="tw-tile-time">Simulasi <span id="mini-twin-clock" class="mono">00:00</span></span>
                @endif
                <span class="tw-tile-go">Buka layar penuh</span>
            </a>
            <a class="tw-card tw-tile" href="{{ route('maps', $q) }}">
                <span class="tw-tile-ico" data-icon="map" data-icon-size="28"></span>
                <h2>Maps</h2>
                <p class="muted">Truk dalam perjalanan menuju gerbang, lengkap dengan plat nomor dan perkiraan tiba.</p>
                @if ($kpi)
                    <canvas id="mini-map" class="tw-mini" aria-hidden="true"></canvas>
                    <span class="tw-tile-time">Simulasi <span id="mini-map-clock" class="mono">00:00</span></span>
                @endif
                <span class="tw-tile-go">Buka layar penuh</span>
            </a>
        </section>

        <div class="dash-cols">
        @if ($kpi)
            <section class="tw-card dash-c-hold" aria-labelledby="h-hold">
                <h2 id="h-hold">Holding time aseptic tank</h2>
                @if ($holding === [])
                    <p class="tw-hint">Tidak ada lot yang mendekati batas holding time.</p>
                @else
                    <ul class="dash-alerts">
                        @foreach ($holding as $a)
                            <li data-state="{{ $a['state'] }}"><b class="mono">{{ $a['asset'] }}</b> lot <span class="mono">{{ $a['lot'] }}</span>: {{ $a['state'] === 'over' ? 'melewati batas' : 'mendekati batas' }}, {{ $a['age_min'] }} dari {{ $a['limit_min'] }} mnt (teramati {{ $a['at'] }} UTC)</li>
                        @endforeach
                    </ul>
                @endif
            </section>
        @endif

        @if ($kpi)
            <section class="tw-card dash-c-ord" id="s-ord" aria-labelledby="h-ord">
                <h2 id="h-ord">Order &amp; kelayakan</h2>
                @if (! $orders)
                    <p class="tw-hint">Run ini belum punya evaluasi order. Buat run baru untuk melihatnya.</p>
                @else
                    <p class="dash-verdict" data-state="{{ $orders['met'] === count($orders['orders']) ? 'ok' : 'short' }}"><b>{{ $orders['met'] }} dari {{ count($orders['orders']) }} order dapat dipenuhi penuh.</b></p>
                    <details class="dash-note"><summary>Catatan asumsi</summary><p class="muted">Susu per ton produk jadi: full cream {{ $fmt($orders['milk_use_full_pct'], 0) }}%, rasa {{ $fmt($orders['milk_use_flavour_pct'], 0) }}% (nilai demo). {{ $orders['source'] === 'manual' ? 'Order dari parameter operasional.' : 'Order otomatis dari susu terjadwal per SKU; isi order sendiri di Parameter operasional.' }}</p></details>
                    <div class="tw-table-scroll" tabindex="0" aria-label="Order dan kelayakan, dapat digulir">
                        <table class="dash-table">
                            <thead><tr><th>Order</th><th>SKU</th><th class="num">Diminta (L)</th><th class="num">Terpenuhi (L)</th><th class="num">Kurang (L)</th><th>Status</th></tr></thead>
                            <tbody>
                            @foreach ($orders['orders'] as $o)
                                <tr>
                                    <td class="mono">{{ $o['order'] }}</td>
                                    <td class="mono">{{ $o['sku'] }}</td>
                                    <td class="num">{{ \App\Support\Volume::l($o['ordered_ton']) }}</td>
                                    <td class="num">{{ \App\Support\Volume::l($o['fulfilled_ton']) }}</td>
                                    <td class="num">{{ \App\Support\Volume::l($o['shortfall_ton']) }}</td>
                                    <td>
                                        <span class="badge" data-state="{{ $o['feasible'] ? 'ok' : 'short' }}">{{ $o['feasible'] ? 'Dapat dipenuhi' : 'Tidak penuh' }}</span>
                                        @unless ($o['feasible'])
                                            <small class="cause">{{ collect($o['causes'])->map(fn ($c) => $c['label'].' ('.\App\Support\Volume::l($c['milk_ton']).' susu)')->implode('; ') }}</small>
                                        @endunless
                                    </td>
                                </tr>
                            @endforeach
                            </tbody>
                        </table>
                    </div>
                @endif
            </section>
        @endif

        @if ($kpi)
            @php
                $utilLabels = ['bay' => 'Bay', 'degassing' => 'Degassing', 'thermal' => 'Thermalisasi', 'separator' => 'Separator', 'sterilizer' => 'Sterilizer', 'filling_line' => 'Filling line'];
                $fillRate = $orders && count($orders['orders']) ? round(100 * $orders['met'] / count($orders['orders'])) : null;
                $recv = $balance ? $balance['in'][1]['ton'] : 0;
                $fgOut = $balance ? $balance['out'][0]['ton'] : 0;
            @endphp
            <section class="tw-card dash-c-bal" aria-labelledby="h-bal">
                <h2 id="h-bal">Neraca volume &amp; KPI</h2>
                @if (! $balance)
                    <p class="tw-hint">Run ini belum punya neraca volume. Buat run baru untuk melihatnya.</p>
                @else
                    <p class="dash-verdict" data-state="{{ $balance['balanced'] ? 'ok' : 'over' }}"><b>{{ $balance['balanced'] ? 'Neraca seimbang.' : 'Neraca tidak seimbang, periksa data run.' }}</b></p>
                    <details class="dash-note"><summary>Catatan asumsi</summary><p class="muted">Satuan liter; engine menghitung dalam ton dengan massa jenis susu 1,03 kg/L (1 ton = 970,87 L). @if ($balance['not_received_ton'] > 0) {{ \App\Support\Volume::l($balance['not_received_ton']) }} susu tidak diterima karena truk ditahan atau ditolak di gerbang atau lab. @endif Stok awal bukan bagian dari proses simulasi; ia dicatat apa adanya sebagai sisa.</p></details>
                    <div class="tw-table-scroll" tabindex="0" aria-label="Neraca volume, dapat digulir">
                        <table class="dash-table">
                            <thead><tr><th>Masuk</th><th class="num">Liter</th><th>Keluar atau sisa</th><th class="num">Liter</th></tr></thead>
                            <tbody>
                            @for ($i = 0; $i < max(count($balance['in']), count($balance['out'])); $i++)
                                <tr>
                                    @foreach (['in', 'out'] as $side)
                                        @php($r = $balance[$side][$i] ?? null)
                                        <td>{{ $r['label'] ?? '' }}</td>
                                        <td class="num">@if ($r){{ \App\Support\Volume::l($r['ton']) }}@endif</td>
                                    @endforeach
                                </tr>
                            @endfor
                            <tr class="total">
                                <th scope="row">Total masuk</th><td class="num">{{ \App\Support\Volume::l($balance['in_total']) }}</td>
                                <th scope="row">Total keluar dan sisa</th><td class="num">{{ \App\Support\Volume::l($balance['out_total']) }}</td>
                            </tr>
                            </tbody>
                        </table>
                    </div>
                @endif
                <ul class="dash-alerts">
                    <li>Rendemen produk jadi: {{ $recv > 0 ? $fmt(100 * $fgOut / $recv) . '%' : '-' }} dari susu diterima.</li>
                    <li>Order terpenuhi penuh: {{ $fillRate === null ? '-' : $fillRate . '% (' . $orders['met'] . ' dari ' . count($orders['orders']) . ')' }}.</li>
                    <li>Utilisasi aset: @foreach ($kpi['utilization_pct'] ?? [] as $k => $v){{ $utilLabels[$k] ?? $k }} {{ $fmt($v) }}%@if (! $loop->last), @endif @endforeach</li>
                </ul>
            </section>
        @endif

        @if ($kpi)
            <section class="tw-card dash-c-wear" aria-labelledby="h-wear">
                <h2 id="h-wear">Fouling &amp; umur simpan</h2>
                @if (! $wear)
                    <p class="tw-hint">Run ini belum punya data fouling dan umur simpan. Buat run baru untuk melihatnya.</p>
                @else
                    @php($f = $wear['fouling'])
                    @php($e = $wear['expiry'])
                    @php($overN = collect($f['sterilizers'])->where('state', 'over')->count())
                    @php($nearN = collect($f['sterilizers'])->where('state', 'near')->count())
                    @php($shortN = collect($e['skus'])->where('state', '!=', 'ok')->count())
                    <p class="dash-verdict" data-state="{{ $overN ? 'over' : ($nearN ? 'near' : 'ok') }}"><b>{{ $overN }} dari {{ count($f['sterilizers']) }} sterilizer melewati batas, {{ $nearN }} mendekati.</b> <span>{{ $shortN }} dari {{ count($e['skus']) }} SKU di bawah sisa umur minimum.</span></p>
                    <details class="dash-note"><summary>Catatan asumsi</summary><p class="muted">Fouling dihitung dari menit sterilisasi sejak CIP terakhir terhadap batas {{ $fmt($f['limit_min'], 0) }} menit. Hanya CIP darurat yang mereset hitungan; CIP terjadwal sterilizer belum dimodelkan, dan fouling belum memengaruhi proses (nilai demo). Umur simpan {{ $fmt($e['shelf_life_days'], 0) }} hari, tiba di pelanggan {{ $fmt($e['dispatch_lead_days'], 0) }} hari setelah pengisian. Sisa umur minimum yang diterima pelanggan {{ $fmt($e['min_remaining_pct'], 0) }}% (nilai demo).</p></details>
                    <div class="dash-pair">
                    <div class="tw-table-scroll" tabindex="0" aria-label="Fouling sterilizer, dapat digulir">
                        <table class="dash-table">
                            <thead><tr><th>Sterilizer</th><th class="num">Terpanjang sejak CIP (mnt)</th><th class="num">Akhir hari (mnt)</th><th class="num">CIP darurat</th><th>Batas tercapai</th><th>Status</th></tr></thead>
                            <tbody>
                            @foreach ($f['sterilizers'] as $s)
                                <tr>
                                    <td class="mono">{{ $s['asset_code'] }}</td>
                                    <td class="num">{{ $fmt($s['peak_min'], 0) }}</td>
                                    <td class="num">{{ $fmt($s['run_min'], 0) }}</td>
                                    <td class="num">{{ $s['cip_count'] }}</td>
                                    <td>{{ $s['reached_clock'] ? $s['reached_clock'].' UTC' : '-' }}</td>
                                    <td><span class="badge" data-state="{{ $s['state'] }}">{{ ['ok' => 'Aman', 'near' => 'Mendekati batas', 'over' => 'Melewati batas, CIP disarankan'][$s['state']] }}</span></td>
                                </tr>
                            @endforeach
                            </tbody>
                        </table>
                    </div>
                    @if ($e['skus'] === [])
                        <p class="tw-hint">Belum ada produk jadi yang selesai diisi.</p>
                    @else
                        <div class="tw-table-scroll" tabindex="0" aria-label="Umur simpan per SKU, dapat digulir">
                            <table class="dash-table">
                                <thead><tr><th>SKU</th><th>Lot</th><th class="num">Liter</th><th>Isi pertama</th><th>Kedaluwarsa</th><th class="num">Sisa umur saat tiba</th><th>Status</th></tr></thead>
                                <tbody>
                                @foreach ($e['skus'] as $r)
                                    <tr>
                                        <td class="mono">{{ $r['sku'] }}</td>
                                        <td>{{ $r['lots'] }}</td>
                                        <td class="num">{{ \App\Support\Volume::l($r['volume_ton']) }}</td>
                                        <td class="mono">{{ $r['produced_on'] }}</td>
                                        <td class="mono">{{ $r['expires_on'] }}</td>
                                        <td class="num">{{ $fmt($r['remaining_pct'], 0) }}%</td>
                                        <td><span class="badge" data-state="{{ $r['state'] }}">{{ $r['state'] === 'ok' ? 'Memenuhi' : 'Di bawah minimum' }}</span></td>
                                    </tr>
                                @endforeach
                                </tbody>
                            </table>
                        </div>
                    @endif
                    </div>
                @endif
            </section>
        @endif
        </div>

        <section class="tw-card" aria-labelledby="h-sched">
            <h2 id="h-sched">Jadwal hari ini</h2>
            @if ($schedule === [])
                <p class="tw-hint">Belum ada jadwal kedatangan untuk run ini.</p>
            @else
                <div class="tw-table-scroll tall" tabindex="0" aria-label="Jadwal kedatangan truk, dapat digulir">
                    <table>
                        <thead><tr><th>Truk</th><th>Plat</th><th>Asal</th><th>Perkiraan tiba</th><th>Tiba</th><th>Volume</th><th>Bay</th><th>Status akhir</th></tr></thead>
                        <tbody>
                        @foreach ($schedule as $t)
                            <tr>
                                <td class="mono">{{ $t['code'] }}</td>
                                <td class="mono">{{ $t['plate'] ?? '-' }}</td>
                                <td>{{ $t['farm'] }}</td>
                                <td class="mono">{{ $t['eta'] ?? '-' }}</td>
                                <td class="mono">{{ $t['arrived'] ?? '-' }}</td>
                                <td>{{ $t['volume'] !== null ? \App\Support\Volume::l($t['volume']) : '-' }}</td>
                                <td>{{ $t['bay'] ?? '-' }}</td>
                                <td>{{ $t['status'] ?? '-' }}</td>
                            </tr>
                        @endforeach
                        </tbody>
                    </table>
                </div>
                <p class="muted">Waktu simulasi (UTC). Plat nomor sintetis.</p>
            @endif
        </section>
    </main>

    @include('runs._drawer')
</div>
@endsection
