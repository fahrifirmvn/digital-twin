@extends('layouts.app')
@section('title', 'Traceability | LactaTwin')
@section('content')
<div class="card">
    <h1>Traceability &amp; Silsilah Batch</h1>
    <form method="GET" action="{{ route('trace') }}" class="run-form">
        <label>Run
            <select name="run">
                @foreach ($runs as $id)
                    <option value="{{ $id }}" @selected($id === $runId)>#{{ $id }}</option>
                @endforeach
            </select>
        </label>
        <label>Kode batch / truk <input type="text" name="code" value="{{ $code }}" placeholder="FG-0001 / INT-0001 / RT-001" maxlength="40" required></label>
        <button type="submit">Telusuri</button>
    </form>
    @if ($errors->any())<p class="err">{{ $errors->first() }}</p>@endif
    @if ($runs->isEmpty())
        <p>Belum ada run yang selesai.</p>
    @else
        @if ($examples->isNotEmpty())
            <p>Contoh kode FG: @foreach ($examples as $e)<a href="{{ route('trace', ['run' => $runId, 'code' => $e]) }}">{{ $e }}</a>@if (! $loop->last), @endif @endforeach</p>
        @endif
        @if (($mixedExamples ?? collect())->isNotEmpty())
            <p class="muted">Contoh FG Commingled (MIXED): @foreach ($mixedExamples as $e)<a href="{{ route('trace', ['run' => $runId, 'code' => $e]) }}">{{ $e }}</a>@if (! $loop->last), @endif @endforeach</p>
        @endif
        @if (($splitExamples ?? collect())->isNotEmpty())
            <p class="muted">Contoh INT Terpecah (SPLIT): @foreach ($splitExamples as $e)<a href="{{ route('trace', ['run' => $runId, 'code' => $e]) }}">{{ $e }}</a>@if (! $loop->last), @endif @endforeach</p>
        @endif
        @if (($tankerExamples ?? collect())->isNotEmpty())
            <p class="muted">Telusur maju dari truk (Forward Trace): @foreach ($tankerExamples as $tk)<a href="{{ route('trace', ['run' => $runId, 'code' => $tk]) }}">{{ $tk }}</a>@if (! $loop->last), @endif @endforeach</p>
        @endif
    @endif
    @if (! empty($balance))
        <p class="muted" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);">
            <b>Neraca Volume Run #{{ $runId }} (06:00–06:00 WIB):</b>
            Stok awal {{ \App\Support\Volume::l($balance['opening_stock_ton'] ?? 0) }}
            + Susu diterima {{ \App\Support\Volume::l($balance['received_ton'] ?? 0) }}
            = Output FG {{ \App\Support\Volume::l($balance['fg_ton'] ?? 0) }}
            + Susut proses {{ \App\Support\Volume::l($balance['loss_ton'] ?? 0) }}
            + Ditahan QA {{ \App\Support\Volume::l($balance['qa_hold_ton'] ?? 0) }}
            + Stok akhir {{ \App\Support\Volume::l($balance['closing_stock_ton'] ?? 0) }}
            · <span class="{{ $balance['balanced'] ? 'ok' : 'err' }}">Residual: {{ \App\Support\Volume::l($balance['residual_ton'] ?? 0) }} ({{ $balance['balanced'] ? 'Seimbang' : 'Periksa selisih' }})</span>
        </p>
    @endif
</div>

@if ($notFound)
    <div class="card err">Batch {{ $code }} tidak ditemukan di run #{{ $runId }}.</div>
@endif

@if ($trace)
    @php
        $link = fn ($c) => route('trace', ['run' => $runId, 'code' => $c]);
        $b = $trace['batch'];
        $directParents = collect($trace['upstream'])->where('depth', 1)->count();
        $directChildren = collect($trace['downstream'])->where('depth', 1)->count();
        $allNodes = collect([$b, ...$trace['upstream'], ...$trace['downstream']])->unique('code');
        $rawNodes = $allNodes->where('type', 'raw')->values();
        $intNodes = $allNodes->where('type', 'intermediate')->values();
        $fgNodes = $allNodes->where('type', 'fg')->values();
        $edges = $trace['edges'] ?? [];
        $mass = $trace['mass_summary'] ?? null;
    @endphp
    <div class="card">
        @if (! empty($trace['resolved_from_tanker']))
            <p class="ok" style="margin-bottom:6px;">Penelusuran maju (<i>Forward Trace</i>) dari truk <b>{{ $trace['resolved_from_tanker'] }}</b> &rarr; batch hulu <b class="mono">{{ $b['code'] }}</b>.</p>
        @endif
        <h2 class="sub">
            {{ $b['code'] }}
            <span class="badge">{{ $b['type'] }}</span>
            @if ($directParents > 1)
                <span class="badge">MIXED ({{ $directParents }} induk)</span>
            @endif
            @if ($directChildren > 1)
                <span class="badge">SPLIT ({{ $directChildren }} lot)</span>
            @endif
        </h2>
        <p>
            {{ \App\Support\Volume::l($b['volume_ton']) }}, status {{ $b['status'] }}@if ($b['sku_code']), SKU {{ $b['sku_code'] }}@endif
            @if (! empty($b['tanks']))
                · Tangki: @foreach ($b['tanks'] as $tk)<span class="mono">{{ \App\Support\AssetLabel::dual($tk) }}</span>@if (! $loop->last), @endif @endforeach
            @endif
            @if (! empty($b['filling_line']))
                · Lini: <span class="mono">{{ \App\Support\AssetLabel::dual($b['filling_line']) }}</span>
            @endif
        </p>
    </div>

    <div class="card">
        <h2 class="sub">Peta Aliran Silsilah Batch (Hulu &rarr; Proses &rarr; Hilir)</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:10px 0;">
            <div style="border:1px solid var(--line);border-radius:8px;padding:10px;">
                <b>1. Hulu: Penerimaan &amp; Tangki Mentah (RAW)</b>
                @forelse ($rawNodes as $rn)
                    <div style="margin-top:6px;padding:6px;border-radius:6px;background:rgba(148,163,184,0.08);">
                        <a href="{{ $link($rn['code']) }}" class="mono"><b>{{ $rn['code'] }}</b></a>
                        @if ($rn['code'] === $b['code']) <span class="badge">FOKUS</span> @endif
                        <div class="muted">{{ \App\Support\Volume::l($rn['volume_ton']) }} @if (! empty($rn['tanks'])) · {{ implode(', ', array_map(fn ($x) => \App\Support\AssetLabel::dual($x), $rn['tanks'])) }} @endif</div>
                    </div>
                @empty
                    <p class="muted">Tidak ada simpul RAW.</p>
                @endforelse
            </div>
            <div style="border:1px solid var(--line);border-radius:8px;padding:10px;">
                <b>2. Olahan: Storage &amp; Aseptik (INT)</b>
                @forelse ($intNodes as $in)
                    <div style="margin-top:6px;padding:6px;border-radius:6px;background:rgba(148,163,184,0.08);">
                        <a href="{{ $link($in['code']) }}" class="mono"><b>{{ $in['code'] }}</b></a>
                        @if ($in['code'] === $b['code']) <span class="badge">FOKUS</span> @endif
                        <div class="muted">{{ \App\Support\Volume::l($in['volume_ton']) }} · {{ $in['status'] }} @if (! empty($in['tanks'])) · {{ implode(', ', array_map(fn ($x) => \App\Support\AssetLabel::dual($x), $in['tanks'])) }} @endif</div>
                    </div>
                @empty
                    <p class="muted">Tidak ada simpul INT.</p>
                @endforelse
            </div>
            <div style="border:1px solid var(--line);border-radius:8px;padding:10px;">
                <b>3. Hilir: Produk Jadi &amp; Lini (FG)</b>
                @forelse ($fgNodes as $fn)
                    <div style="margin-top:6px;padding:6px;border-radius:6px;background:rgba(148,163,184,0.08);">
                        <a href="{{ $link($fn['code']) }}" class="mono"><b>{{ $fn['code'] }}</b></a>
                        @if ($fn['code'] === $b['code']) <span class="badge">FOKUS</span> @endif
                        <div class="muted">{{ \App\Support\Volume::l($fn['volume_ton']) }} · {{ $fn['sku_code'] ?? '-' }} @if (! empty($fn['filling_line'])) · {{ \App\Support\AssetLabel::dual($fn['filling_line']) }} @endif</div>
                    </div>
                @empty
                    <p class="muted">Tidak ada simpul FG.</p>
                @endforelse
            </div>
        </div>
        @if (! empty($edges))
            <h3 class="sub">Atribusi Sisi Silsilah (Induk &rarr; Anak)</h3>
            <table>
                <thead><tr><th>Batch Induk</th><th>Batch Anak</th><th>Volume Kontribusi (L)</th><th>Porsi pada Batch Anak</th></tr></thead>
                <tbody>
                @foreach ($edges as $edge)
                    <tr>
                        <td class="mono"><a href="{{ $link($edge['parent_code']) }}">{{ $edge['parent_code'] }}</a> <span class="muted">({{ $edge['parent_type'] }})</span></td>
                        <td class="mono"><a href="{{ $link($edge['child_code']) }}">{{ $edge['child_code'] }}</a> <span class="muted">({{ $edge['child_type'] }})</span></td>
                        <td>{{ \App\Support\Volume::l($edge['volume_ton']) }}</td>
                        <td>{{ number_format((float) $edge['share_pct'], 1, ',', '.') }}%</td>
                    </tr>
                @endforeach
                </tbody>
            </table>
        @endif
        @if ($mass)
            <p class="muted" style="margin-top:8px;">
                <b>Rekonsiliasi Massa Sub-Graf Silsilah:</b>
                Total RAW terlibat {{ \App\Support\Volume::l($mass['raw_ton']) }}
                &rarr; Total INT terlibat {{ \App\Support\Volume::l($mass['intermediate_ton']) }}
                &rarr; Total FG terlibat {{ \App\Support\Volume::l($mass['fg_ton']) }}
                (rendemen tiap tahap ~99,5%, sisa bagian batch yang terpecah masuk ke cabang silsilah terkait).
            </p>
        @endif
    </div>

    <div class="card">
        <h2 class="sub">Asal (hulu)</h2>
        @if ($trace['upstream'] === [])
            <p>Tidak ada batch induk.</p>
        @else
            <table>
                <thead><tr><th>Langkah</th><th>Batch</th><th>Tipe</th><th>Tangki / Lini</th><th>Volume (L)</th></tr></thead>
                <tbody>
                @foreach ($trace['upstream'] as $n)
                    <tr>
                        <td>-{{ $n['depth'] }}</td>
                        <td class="mono"><a href="{{ $link($n['code']) }}">{{ $n['code'] }}</a></td>
                        <td>{{ $n['type'] }}</td>
                        <td class="mono">{{ ! empty($n['tanks']) ? implode(', ', array_map(fn ($x) => \App\Support\AssetLabel::dual($x), $n['tanks'])) : '-' }}</td>
                        <td>{{ \App\Support\Volume::l($n['volume_ton']) }}</td>
                    </tr>
                @endforeach
                </tbody>
            </table>
        @endif
        <h3 class="sub">Truk dan peternakan sumber</h3>
        @if (count($trace['tankers']) === 0)
            <p>Tidak ada truk terkait.</p>
        @else
            <table>
                <thead><tr><th>Truk</th><th>Peternakan</th><th>Volume (L)</th><th>Suhu awal (C)</th><th>Status</th></tr></thead>
                <tbody>
                @foreach ($trace['tankers'] as $t)
                    <tr><td class="mono"><a href="{{ $link($t->code) }}">{{ $t->code }}</a></td><td>{{ $t->farm_code }} {{ $t->farm_name }}</td><td>{{ \App\Support\Volume::l($t->volume_ton) }}</td><td>{{ $t->initial_temp_c }}</td><td>{{ $t->status }}</td></tr>
                @endforeach
                </tbody>
            </table>
        @endif
    </div>

    <div class="card">
        <h2 class="sub">Turunan (hilir)</h2>
        @if ($trace['downstream'] === [])
            <p>Tidak ada batch turunan.</p>
        @else
            <table>
                <thead><tr><th>Langkah</th><th>Batch</th><th>Tipe</th><th>SKU</th><th>Tangki / Lini</th><th>Volume (L)</th><th>Status</th></tr></thead>
                <tbody>
                @foreach ($trace['downstream'] as $n)
                    <tr>
                        <td>+{{ $n['depth'] }}</td>
                        <td class="mono"><a href="{{ $link($n['code']) }}">{{ $n['code'] }}</a></td>
                        <td>{{ $n['type'] }}</td>
                        <td>{{ $n['sku_code'] ?? '-' }}</td>
                        <td class="mono">{{ $n['filling_line'] ? \App\Support\AssetLabel::dual($n['filling_line']) : (! empty($n['tanks']) ? implode(', ', array_map(fn ($x) => \App\Support\AssetLabel::dual($x), $n['tanks'])) : '-') }}</td>
                        <td>{{ \App\Support\Volume::l($n['volume_ton']) }}</td>
                        <td>{{ $n['status'] }}</td>
                    </tr>
                @endforeach
                </tbody>
            </table>
        @endif
    </div>

    <div class="card">
        <h2 class="sub">Jalur perpindahan susu</h2>
        <table>
            <thead><tr><th>Jam Operasional (06:00–06:00)</th><th>Waktu (UTC)</th><th>Batch</th><th>Dari</th><th>Ke</th><th>Volume (L)</th><th>Singgah Tangki (Batas G4 &le; 240 mnt)</th></tr></thead>
            <tbody>
            @foreach ($trace['transfers'] as $t)
                <tr>
                    <td class="mono">{{ $t->clock_wib ?? '-' }} <span class="muted">(mnt {{ $t->sim_minute ?? 0 }})</span></td>
                    <td>{{ \Illuminate\Support\Str::of($t->occurred_at)->limit(19, '') }}</td>
                    <td class="mono"><a href="{{ $link($t->batch_code) }}">{{ $t->batch_code }}</a></td>
                    <td>{{ \App\Support\AssetLabel::dual($t->from_asset) }}</td>
                    <td>{{ \App\Support\AssetLabel::dual($t->to_asset) }}</td>
                    <td>{{ \App\Support\Volume::l($t->volume_ton) }}</td>
                    <td>
                        @if (($t->dwell_min ?? null) !== null)
                            <span class="{{ ($t->dwell_ok ?? true) ? 'ok' : 'err' }}">{{ $t->dwell_min }} mnt ({{ ($t->dwell_ok ?? true) ? 'Aman G4' : 'Lewat G4' }})</span>
                        @else
                            <span class="muted">-</span>
                        @endif
                    </td>
                </tr>
            @endforeach
            </tbody>
        </table>
    </div>

    <div class="card">
        <h2 class="sub">Keputusan gate</h2>
        <table>
            <thead><tr><th>Gate</th><th>Objek</th><th>Keputusan</th><th>Alasan</th><th>Oleh</th></tr></thead>
            <tbody>
            @foreach ($trace['gates'] as $g)
                <tr><td>{{ $g->gate }}</td><td class="mono">{{ $g->object_id }}</td><td class="{{ $g->decision === 'pass' ? 'ok' : 'err' }}">{{ $g->decision }}</td><td>{{ $g->reason ?? '-' }}</td><td>{{ $g->decided_by }}</td></tr>
            @endforeach
            </tbody>
        </table>
    </div>
@endif
@endsection
