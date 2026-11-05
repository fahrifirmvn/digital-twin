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
    $chips = [
        ['Truk hari ini', $kpi['trucks'] ?? null, 0, isset($kpi) ? ($kpi['completed'] + $kpi['held_qa']).' selesai bongkar' : ''],
        ['Susu diterima', isset($kpi['raw_ton']) ? \App\Support\Volume::liters($kpi['raw_ton']) : null, 0, 'liter'],
        ['Produk jadi', isset($kpi['fg_ton']) ? \App\Support\Volume::liters($kpi['fg_ton']) : null, 0, 'liter'],
        ['Tunggu truk', $kpi['truck_wait_min']['mean'] ?? null, 1, 'menit, rata-rata'],
    ];
    // Perlu perhatian: hanya yang menyimpang; kejadian rutin (CIP malam) tidak ditampilkan.
    $attention = collect($run->day_result['summary']['issues'] ?? [])->reject(fn ($t) => str_starts_with($t, 'CIP terjadwal'))->values()->all();
    if ($kpi) {
        if (! empty($holding)) {
            $attention[] = count($holding).' lot aseptic tank mendekati atau melewati batas holding time';
        }
        $short = $orders ? count($orders['orders']) - $orders['met'] : 0;
        if ($short > 0) {
            $attention[] = $short.' order belum terpenuhi penuh';
        }
        $overN = $wear ? collect($wear['fouling']['sterilizers'])->where('state', 'over')->count() : 0;
        if ($overN > 0) {
            $attention[] = $overN.' sterilizer melewati batas fouling, CIP disarankan';
        }
        if (($kpi['false_accept'] ?? 0) > 0) {
            $attention[] = $kpi['false_accept'].' susu di luar mutu lolos gerbang (false accept)';
        }
    }
    $dayNo = $run->day_result['day'] ?? null;
@endphp
<div id="tw" class="tw tw-dash" data-theme="light" @if ($kpi) data-replay-url="{{ route('runs.replay', $run) }}" data-run-id="{{ $run->id }}" data-day="{{ $dayNo }}" data-plant="{{ json_encode((object) $run->plant()) }}" @endif>
    @include('runs._topbar', ['active' => 'dashboard', 'staticStatus' => $run->status])

    <main class="dash">
        <div class="dash-head">
            <h1>Dashboard</h1>
        </div>

        @if (session('status'))
            <div class="tw-card ok" role="status">{{ session('status') }}</div>
        @endif

        @if (! $kpi)
            <div class="tw-card" role="status"><p class="muted">Hari ini belum selesai dihitung. Ringkasan akan muncul setelahnya.</p></div>
        @endif

        <section class="dash-kpis" aria-label="Ringkasan hari ini">
            @foreach ($chips as [$label, $value, $dec, $note])
                <div class="tw-card kpi"><span>{{ $label }}</span><b>{{ $fmt($value, $dec) }}</b><small>{{ $note }}</small></div>
            @endforeach
        </section>

        @if ($kpi)
            @php
                $cfgCode = $run->config_snapshot['config'] ?? 'A';
                $cfgLabel = config('twin.configs')[$cfgCode] ?? $cfgCode;
            @endphp
            <section class="tw-card" aria-labelledby="h-loop" style="margin-bottom:12px;">
                <h2 id="h-loop">Siklus Target Teknis &amp; 4 Masalah Utama [Nama Pabrik]</h2>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px;font-size:0.85rem;">
                    <span class="badge" data-state="ok">1. Data Operasional ({{ $kpi['trucks'] ?? 0 }} truk · {{ \App\Support\Volume::l($kpi['raw_ton'] ?? 0) }})</span>
                    <span>&rarr;</span>
                    <span class="badge" data-state="ok">2. Kalkulasi (AI Kuantil + CP-SAT)</span>
                    <span>&rarr;</span>
                    <span class="badge" data-state="ok">3. Rekomendasi ({{ $cfgCode }}: {{ $cfgLabel }})</span>
                    <span>&rarr;</span>
                    <span class="badge" data-state="ok">4. Hasil KPI ({{ $orders ? $orders['met'].'/'.count($orders['orders']).' order' : 'Evaluasi' }})</span>
                    <span>&rarr;</span>
                    <a href="{{ route('runs.show', $run) }}#h-decide" class="badge">5. Keputusan PPIC/QA</a>
                    <span>&rarr;</span>
                    <a href="{{ route('runs.show', $run) }}#params" class="badge">6. Uji Ulang Parameter</a>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;">
                    <div style="border:1px solid var(--line);border-radius:8px;padding:10px;">
                        <small class="muted">Masalah 1 · Kedatangan &amp; Antrean Truk</small>
                        <div><b>Tunggu rata-rata {{ $fmt($kpi['truck_wait_min']['mean'] ?? null, 1) }} mnt</b> <span class="muted">(P90 {{ $fmt($kpi['truck_wait_min']['p90'] ?? null, 1) }} mnt)</span></div>
                        <small class="muted">Uji lab rata-rata {{ $fmt($kpi['lab_wait_min']['mean'] ?? null, 1) }} mnt · Dwell tangki {{ $fmt($kpi['tank_dwell_min']['mean'] ?? null, 1) }} mnt</small>
                    </div>
                    <div style="border:1px solid var(--line);border-radius:8px;padding:10px;">
                        <small class="muted">Masalah 2 · Rencana Produksi Dinamis</small>
                        <div><b>{{ $orders ? $orders['met'].' dari '.count($orders['orders']).' order terpenuhi' : 'Belum dievaluasi' }}</b></div>
                        <small class="muted">Susu dipakai {{ isset($orders['total_milk_used_ton']) ? \App\Support\Volume::l($orders['total_milk_used_ton']) : '-' }} dari {{ isset($orders['total_milk_needed_ton']) ? \App\Support\Volume::l($orders['total_milk_needed_ton']) : '-' }} · <a href="#s-ord">Rincian</a></small>
                    </div>
                    <div style="border:1px solid var(--line);border-radius:8px;padding:10px;">
                        <small class="muted">Masalah 3 · Konfigurasi Mesin &amp; Pipa</small>
                        <div><b>{{ ! empty($routes) ? $routes['usable_count'].'/'.$routes['total_count'].' rute STE→AT→FL aktif' : 'Rute standar aktif' }}</b></div>
                        <small class="muted">Changeover {{ $kpi['changeover_count'] ?? 0 }}x ({{ $fmt($kpi['changeover_min'] ?? 0, 0) }} mnt) · CIP {{ $routes['cip_total'] ?? ($kpi['unscheduled_cip'] ?? 0) }}x · <a href="#s-routes">Matriks</a></small>
                    </div>
                    <div style="border:1px solid var(--line);border-radius:8px;padding:10px;">
                        <small class="muted">Masalah 4 · Traceability &amp; Visibilitas FG</small>
                        <div><b>Cakupan silsilah {{ $fmt($kpi['trace_coverage_pct'] ?? 100, 0) }}% · {{ \App\Support\Volume::l($kpi['fg_ton'] ?? 0) }} FG</b></div>
                        <small class="muted">Neraca {{ ($balance['balanced'] ?? true) ? 'Seimbang (Residual 0 L)' : 'Periksa' }} · <a href="{{ route('trace', $q) }}">Telusuri Batch</a></small>
                    </div>
                </div>
            </section>
        @endif

        <section class="tw-card dash-attn" aria-labelledby="h-attn">
            <h2 id="h-attn">Perlu perhatian</h2>
            @if ($kpi && $attention === [])
                <p class="tw-hint">Tidak ada. Semua berjalan normal.</p>
            @elseif ($attention !== [])
                <ul class="dash-alerts">
                    @foreach ($attention as $t)
                        <li>{{ $t }}</li>
                    @endforeach
                </ul>
            @else
                <p class="tw-hint">-</p>
            @endif
        </section>

        <section class="dash-tiles" aria-label="Pratinjau">
            <a class="tw-card tw-tile" href="{{ route('twin', $q) }}">
                <h2>Digital Twin</h2>
                @if ($kpi)
                    <div class="tw-prev">
                        <canvas id="mini-twin" class="tw-mini" aria-hidden="true"></canvas>
                        <div id="home3d" class="tw-mini tw-mini3d" aria-hidden="true" hidden></div>
                    </div>
                    <span class="tw-tile-time">@if ($dayNo) Hari {{ $dayNo }} · @endif<span id="mini-twin-clock" class="mono">00:00</span></span>
                @endif
                <span class="tw-tile-go">Buka layar penuh</span>
            </a>
            <a class="tw-card tw-tile" href="{{ route('maps', $q) }}">
                <h2>Maps</h2>
                @if ($kpi)
                    <canvas id="mini-map" class="tw-mini" aria-hidden="true"></canvas>
                    <span class="tw-tile-time"><span id="mini-map-clock" class="mono">00:00</span></span>
                @endif
                <span class="tw-tile-go">Buka layar penuh</span>
            </a>
        </section>

        <details class="tw-card dash-more" @if ($kpi) open @endif>
            <summary>Rincian operasional</summary>
        <div class="dash-cols">
        @if ($kpi)
            <section class="tw-card dash-c-hold" aria-labelledby="h-hold">
                <h2 id="h-hold">Holding time aseptic tank</h2>
                @if ($holding === [])
                    <p class="tw-hint">Tidak ada lot yang mendekati batas holding time.</p>
                @else
                    <ul class="dash-alerts">
                        @foreach ($holding as $a)
                            @php
                                $holdPct = $a['limit_min'] > 0 ? min(100, round(100 * $a['age_min'] / $a['limit_min'])) : 0;
                            @endphp
                            <li data-state="{{ $a['state'] }}">
                                <b class="mono">{{ $a['asset'] }}</b> lot <span class="mono">{{ $a['lot'] }}</span>: {{ $a['state'] === 'over' ? 'melewati batas' : 'mendekati batas' }}, {{ $a['age_min'] }} dari {{ $a['limit_min'] }} mnt (teramati {{ $a['at'] }} UTC)
                                <span class="tw-meter" data-state="{{ $a['state'] }}" aria-hidden="true"><i style="width: {{ $holdPct }}%"></i></span>
                            </li>
                        @endforeach
                    </ul>
                @endif
            </section>
        @endif

        @if ($kpi)
            <section class="tw-card dash-c-ord" id="s-ord" aria-labelledby="h-ord">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                    <h2 id="h-ord" style="margin:0;">Order &amp; kelayakan</h2>
                    <a class="tw-btn" href="{{ route('runs.show', $run) }}#params"><span>Ubah Order &amp; Uji Ulang</span></a>
                </div>
                @if (! $orders)
                    <p class="tw-hint">Run ini belum punya evaluasi order. Buat run baru untuk melihatnya.</p>
                @else
                    <p class="dash-verdict" data-state="{{ $orders['met'] === count($orders['orders']) ? 'ok' : 'short' }}"><b>{{ $orders['met'] }} dari {{ count($orders['orders']) }} order dapat dipenuhi penuh.</b></p>
                    <details class="dash-note"><summary>Catatan asumsi</summary><p class="muted">Susu per ton produk jadi: full cream {{ $fmt($orders['milk_use_full_pct'], 0) }}%, rasa {{ $fmt($orders['milk_use_flavour_pct'], 0) }}% (nilai demo). {{ $orders['source'] === 'manual' ? 'Order dari parameter operasional.' : 'Order otomatis dari susu terjadwal per SKU; isi order sendiri di Parameter operasional.' }}</p></details>
                    <div class="tw-table-scroll" tabindex="0" aria-label="Order dan kelayakan, dapat digulir">
                        <table class="dash-table">
                            <thead><tr><th>Order</th><th>SKU</th><th class="num">Rasio Susu</th><th class="num">Diminta (L)</th><th class="num">Susu Dibutuhkan (L)</th><th class="num">Terpenuhi (L)</th><th class="num">Kurang (L)</th><th>Status &amp; Rekomendasi PPIC</th></tr></thead>
                            <tbody>
                            @foreach ($orders['orders'] as $o)
                                @php
                                    $ordPct = $o['ordered_ton'] > 0 ? min(100, round(100 * $o['fulfilled_ton'] / $o['ordered_ton'])) : 100;
                                @endphp
                                <tr>
                                    <td class="mono">{{ $o['order'] }}</td>
                                    <td class="mono">{{ $o['sku'] }}</td>
                                    <td class="num">{{ $fmt($o['milk_ratio_pct'] ?? 100, 0) }}%</td>
                                    <td class="num">{{ \App\Support\Volume::l($o['ordered_ton']) }}</td>
                                    <td class="num">{{ isset($o['milk_needed_ton']) ? \App\Support\Volume::l($o['milk_needed_ton']) : '-' }}</td>
                                    <td class="num">
                                        {{ \App\Support\Volume::l($o['fulfilled_ton']) }}
                                        <span class="tw-meter" data-state="{{ $o['feasible'] ? 'ok' : 'short' }}" aria-hidden="true"><i style="width: {{ $ordPct }}%"></i></span>
                                    </td>
                                    <td class="num">{{ \App\Support\Volume::l($o['shortfall_ton']) }}</td>
                                    <td>
                                        <span class="badge" data-state="{{ $o['feasible'] ? 'ok' : 'short' }}">{{ $o['feasible'] ? 'Dapat dipenuhi' : 'Tidak penuh' }}</span>
                                        @unless ($o['feasible'])
                                            <small class="cause">{{ collect($o['causes'])->map(fn ($c) => $c['label'].' ('.\App\Support\Volume::l($c['milk_ton']).' susu)')->implode('; ') }}</small>
                                        @endunless
                                        @if (! empty($o['recommendation']))
                                            <div><small class="muted">{{ $o['recommendation'] }}</small></div>
                                        @endif
                                    </td>
                                </tr>
                            @endforeach
                            </tbody>
                        </table>
                    </div>
                @endif
            </section>
        @endif

        @if ($kpi && ! empty($routes))
            <section class="tw-card dash-c-routes" id="s-routes" aria-labelledby="h-routes">
                <h2 id="h-routes">Konfigurasi mesin &amp; rute perpipaan (AT–FL–SKU)</h2>
                <p class="dash-verdict" data-state="ok">
                    <b>{{ $routes['usable_count'] }} dari {{ $routes['total_count'] }} jalur STE &rarr; AT &rarr; FL aktif</b>
                    <span class="muted"> · Kebijakan: {{ $routes['policy'] === 'dedicated' ? 'Dedikasi SKU per Lini (Dedicated)' : 'Semua SKU (Free)' }} · Total aliran FL &le; Output AT</span>
                </p>
                <details class="dash-note"><summary>Aturan SOP Changeover &amp; Pemicu CIP</summary>
                    <p class="muted">Changeover: pergantian ukuran kemasan tidak menambahkan durasi ganti kertas (non-aditif). Pemicu CIP wajib pada aset terdampak: (1) Rasa Cokelat/Stroberi &rarr; Full Cream ({{ $routes['cip_line'] }}x CIP lini), (2) Tangki penyimpanan habis terkuras ({{ $routes['cip_tank'] }}x CIP tangki), (3) Akumulasi sterilisasi mencapai batas fouling.</p>
                </details>
                <div class="tw-table-scroll" tabindex="0" aria-label="Matriks rute mesin dan perpipaan">
                    <table class="dash-table">
                        <thead><tr><th>Sterilizer</th><th>Aseptic Tank (AT)</th><th>Filling Line (FL)</th><th>Status Rute</th><th>SKU Diizinkan</th></tr></thead>
                        <tbody>
                        @foreach ($routes['routes'] as $rt)
                            <tr>
                                <td class="mono">{{ \App\Support\AssetLabel::dual($rt['sterilizer']) }}</td>
                                <td class="mono">{{ \App\Support\AssetLabel::dual($rt['aseptic']) }}</td>
                                <td class="mono">{{ \App\Support\AssetLabel::dual($rt['line']) }}</td>
                                <td>
                                    <span class="badge" data-state="{{ ($rt['usable'] ?? false) ? 'ok' : 'over' }}">{{ ($rt['usable'] ?? false) ? 'Aktif' : 'Diblokir' }}</span>
                                    @if (! empty($rt['reason']))<small class="muted">{{ $rt['reason'] }}</small>@endif
                                </td>
                                <td class="mono">{{ ! empty($rt['allowed']) ? implode(', ', $rt['allowed']) : '-' }}</td>
                            </tr>
                        @endforeach
                        </tbody>
                    </table>
                </div>
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
                    <p class="dash-verdict" data-state="{{ $balance['balanced'] ? 'ok' : 'over' }}">
                        <b>{{ $balance['balanced'] ? 'Neraca seimbang.' : 'Neraca tidak seimbang, periksa data run.' }}</b>
                        <span class="muted"> · Hari operasi 06:00–06:00 WIB · Residual: {{ \App\Support\Volume::l($balance['residual_ton'] ?? 0) }}</span>
                    </p>
                    @if (($balance['in_total'] ?? 0) > 0)
                        @php
                            $totIn = max(0.01, (float) $balance['in_total']);
                            $pFg = round(100 * ((float) ($balance['fg_ton'] ?? 0)) / $totIn, 1);
                            $pLoss = round(100 * ((float) ($balance['loss_ton'] ?? 0)) / $totIn, 1);
                            $pQa = round(100 * ((float) ($balance['qa_hold_ton'] ?? 0)) / $totIn, 1);
                            $pStock = max(0, round(100 - $pFg - $pLoss - $pQa, 1));
                        @endphp
                        <div class="tw-hint" style="margin:6px 0 8px;">
                            <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--line);gap:1px;" title="Proporsi keluaran terhadap total volume masuk ({{ \App\Support\Volume::l($balance['in_total']) }})">
                                <span style="width:{{ $pFg }}%;background:var(--ok);" title="FG keluar {{ $pFg }}%"></span>
                                <span style="width:{{ $pLoss }}%;background:var(--warn);" title="Susut proses {{ $pLoss }}%"></span>
                                @if ($pQa > 0)<span style="width:{{ $pQa }}%;background:var(--err);" title="Ditahan QA {{ $pQa }}%"></span>@endif
                                @if ($pStock > 0)<span style="width:{{ $pStock }}%;background:var(--accent);" title="Stok akhir tangki {{ $pStock }}%"></span>@endif
                            </div>
                        </div>
                    @endif
                    <details class="dash-note"><summary>Catatan asumsi</summary><p class="muted">Satuan liter; engine menghitung dalam ton dengan massa jenis susu 1,0 kg/L (1 ton = 1.000 L). @if ($balance['not_received_ton'] > 0) {{ \App\Support\Volume::l($balance['not_received_ton']) }} susu tidak diterima karena truk ditahan atau ditolak di gerbang atau lab. @endif Stok awal bukan bagian dari proses hari ini; ia dicatat apa adanya sebagai sisa.</p></details>
                    <div class="tw-table-scroll" tabindex="0" aria-label="Neraca volume, dapat digulir">
                        <table class="dash-table">
                            <thead><tr><th>Masuk</th><th class="num">Liter</th><th>Keluar atau sisa</th><th class="num">Liter</th></tr></thead>
                            <tbody>
                            @for ($i = 0; $i < max(count($balance['in']), count($balance['out'])); $i++)
                                <tr>
                                    @foreach (['in', 'out'] as $side)
                                        @php
                                            $r = $balance[$side][$i] ?? null;
                                        @endphp
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
                @if (! empty($kpi['utilization_pct']))
                    <div class="dash-util-grid" aria-hidden="true">
                        @foreach ($kpi['utilization_pct'] as $k => $v)
                            @php
                                $uPct = min(100, max(0, round((float) $v)));
                            @endphp
                            <div class="dash-util-item">
                                <div class="dash-util-head"><span>{{ $utilLabels[$k] ?? $k }}</span><span class="mono">{{ $fmt($v) }}%</span></div>
                                <span class="tw-meter" data-state="{{ $uPct > 85 ? 'near' : 'ok' }}"><i style="width: {{ $uPct }}%"></i></span>
                            </div>
                        @endforeach
                    </div>
                @endif
            </section>
        @endif

        @if ($kpi)
            <section class="tw-card dash-c-wear" aria-labelledby="h-wear">
                <h2 id="h-wear">Fouling &amp; umur simpan</h2>
                @if (! $wear)
                    <p class="tw-hint">Run ini belum punya data fouling dan umur simpan. Buat run baru untuk melihatnya.</p>
                @else
                    @php
                        $f = $wear['fouling'];
                        $e = $wear['expiry'];
                        $overN = collect($f['sterilizers'])->where('state', 'over')->count();
                        $nearN = collect($f['sterilizers'])->where('state', 'near')->count();
                        $shortN = collect($e['skus'])->where('state', '!=', 'ok')->count();
                    @endphp
                    <p class="dash-verdict" data-state="{{ $overN ? 'over' : ($nearN ? 'near' : 'ok') }}"><b>{{ $overN }} dari {{ count($f['sterilizers']) }} sterilizer melewati batas, {{ $nearN }} mendekati.</b> <span>{{ $shortN }} dari {{ count($e['skus']) }} SKU di bawah sisa umur minimum.</span></p>
                    <details class="dash-note"><summary>Catatan asumsi</summary><p class="muted">Fouling dihitung dari menit sterilisasi sejak CIP terakhir terhadap batas {{ $fmt($f['limit_min'], 0) }} menit. Saat batas tercapai, sterilizer menjalankan CIP terjadwal otomatis dan mereset akumulator menit sterilisasi (nilai demo). Umur simpan {{ $fmt($e['shelf_life_days'], 0) }} hari, tiba di pelanggan {{ $fmt($e['dispatch_lead_days'], 0) }} hari setelah pengisian. Sisa umur minimum yang diterima pelanggan {{ $fmt($e['min_remaining_pct'], 0) }}% (nilai demo).</p></details>
                    <div class="dash-pair">
                    <div class="tw-table-scroll" tabindex="0" aria-label="Fouling sterilizer, dapat digulir">
                        <table class="dash-table">
                            <thead><tr><th>Sterilizer</th><th class="num">Terpanjang sejak CIP (mnt)</th><th class="num">Akhir hari (mnt)</th><th class="num">CIP darurat</th><th>Batas tercapai</th><th>Status</th></tr></thead>
                            <tbody>
                            @foreach ($f['sterilizers'] as $s)
                                @php
                                    $fPct = $f['limit_min'] > 0 ? min(100, round(100 * $s['peak_min'] / $f['limit_min'])) : 0;
                                @endphp
                                <tr>
                                    <td class="mono">{{ $s['asset_code'] }}</td>
                                    <td class="num">
                                        {{ $fmt($s['peak_min'], 0) }}
                                        <span class="tw-meter" data-state="{{ $s['state'] }}" aria-hidden="true"><i style="width: {{ $fPct }}%"></i></span>
                                    </td>
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
                                    @php
                                        $ePct = min(100, max(0, round((float) $r['remaining_pct'])));
                                    @endphp
                                    <tr>
                                        <td class="mono">{{ $r['sku'] }}</td>
                                        <td>{{ $r['lots'] }}</td>
                                        <td class="num">{{ \App\Support\Volume::l($r['volume_ton']) }}</td>
                                        <td class="mono">{{ $r['produced_on'] }}</td>
                                        <td class="mono">{{ $r['expires_on'] }}</td>
                                        <td class="num">
                                            {{ $fmt($r['remaining_pct'], 0) }}%
                                            <span class="tw-meter" data-state="{{ $r['state'] }}" aria-hidden="true"><i style="width: {{ $ePct }}%"></i></span>
                                        </td>
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
                <p class="muted">Waktu dalam UTC.</p>
            @endif
        </section>
        </details>
    </main>

    @include('runs._drawer')
</div>
@endsection
