@extends('layouts.app')
@section('title', 'Traceability | LactaTwin')
@section('content')
<div class="card">
    <h1>Traceability</h1>
    <form method="GET" action="{{ route('trace') }}" class="run-form">
        <label>Run
            <select name="run">
                @foreach ($runs as $id)
                    <option value="{{ $id }}" @selected($id === $runId)>#{{ $id }}</option>
                @endforeach
            </select>
        </label>
        <label>Kode batch <input type="text" name="code" value="{{ $code }}" placeholder="FG-0001" maxlength="40" required></label>
        <button type="submit">Telusuri</button>
    </form>
    @if ($errors->any())<p class="err">{{ $errors->first() }}</p>@endif
    @if ($runs->isEmpty())
        <p>Belum ada run yang selesai.</p>
    @elseif ($examples->isNotEmpty())
        <p>Contoh kode FG: @foreach ($examples as $e)<a href="{{ route('trace', ['run' => $runId, 'code' => $e]) }}">{{ $e }}</a>@if (! $loop->last), @endif @endforeach</p>
    @endif
</div>

@if ($notFound)
    <div class="card err">Batch {{ $code }} tidak ditemukan di run #{{ $runId }}.</div>
@endif

@if ($trace)
    @php
        $link = fn ($c) => route('trace', ['run' => $runId, 'code' => $c]);
        $b = $trace['batch'];
    @endphp
    <div class="card">
        <h2 class="sub">{{ $b['code'] }} <span class="badge">{{ $b['type'] }}</span></h2>
        <p>{{ \App\Support\Volume::l($b['volume_ton']) }}, status {{ $b['status'] }}@if ($b['sku_code']), SKU {{ $b['sku_code'] }}@endif</p>
    </div>

    <div class="card">
        <h2 class="sub">Asal (hulu)</h2>
        @if ($trace['upstream'] === [])
            <p>Tidak ada batch induk.</p>
        @else
            <table>
                <thead><tr><th>Langkah</th><th>Batch</th><th>Tipe</th><th>Volume (L)</th></tr></thead>
                <tbody>
                @foreach ($trace['upstream'] as $n)
                    <tr><td>-{{ $n['depth'] }}</td><td class="mono"><a href="{{ $link($n['code']) }}">{{ $n['code'] }}</a></td><td>{{ $n['type'] }}</td><td>{{ \App\Support\Volume::l($n['volume_ton']) }}</td></tr>
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
                    <tr><td class="mono">{{ $t->code }}</td><td>{{ $t->farm_code }} {{ $t->farm_name }}</td><td>{{ \App\Support\Volume::l($t->volume_ton) }}</td><td>{{ $t->initial_temp_c }}</td><td>{{ $t->status }}</td></tr>
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
                <thead><tr><th>Langkah</th><th>Batch</th><th>Tipe</th><th>SKU</th><th>Volume (L)</th><th>Status</th></tr></thead>
                <tbody>
                @foreach ($trace['downstream'] as $n)
                    <tr><td>+{{ $n['depth'] }}</td><td class="mono"><a href="{{ $link($n['code']) }}">{{ $n['code'] }}</a></td><td>{{ $n['type'] }}</td><td>{{ $n['sku_code'] ?? '-' }}</td><td>{{ \App\Support\Volume::l($n['volume_ton']) }}</td><td>{{ $n['status'] }}</td></tr>
                @endforeach
                </tbody>
            </table>
        @endif
    </div>

    <div class="card">
        <h2 class="sub">Jalur perpindahan susu</h2>
        <table>
            <thead><tr><th>Waktu (UTC)</th><th>Batch</th><th>Dari</th><th>Ke</th><th>Volume (L)</th></tr></thead>
            <tbody>
            @foreach ($trace['transfers'] as $t)
                <tr><td>{{ \Illuminate\Support\Str::of($t->occurred_at)->limit(19, '') }}</td><td class="mono">{{ $t->batch_code }}</td><td>{{ $t->from_asset }}</td><td>{{ $t->to_asset }}</td><td>{{ \App\Support\Volume::l($t->volume_ton) }}</td></tr>
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
