@extends('layouts.app')
@section('title', 'Daftar run | LactaTwin')
@section('content')
<h1 class="sr-only">Daftar run</h1>
@error('engine')<div class="card err">{{ $message }}</div>@enderror

@can('run-scenario')
<div class="card">
    <h2>Jalankan uji</h2>
    <form method="POST" action="{{ route('runs.store') }}" class="run-form">
        @csrf
        <label>Konfigurasi
            <select name="config">
                @foreach (config('twin.configs') as $k => $label)
                    <option value="{{ $k }}" @selected(old('config', 'A') === $k)>{{ $label }}</option>
                @endforeach
            </select>
        </label>
        <label>Skenario
            <select name="scenario">
                @foreach (config('twin.scenarios') as $k => $label)
                    <option value="{{ $k }}" @selected(old('scenario', 'normal') === $k)>{{ $label }}</option>
                @endforeach
            </select>
        </label>
        <label>Seed <input type="number" name="seed" value="{{ old('seed', 1) }}" min="0" required></label>
        <label>Volume harian (ton; 1 t = 971 L) <input type="number" name="volume_ton" value="{{ old('volume_ton', 320) }}" min="50" max="600" step="10" required></label>
        <label>Truk di luar batas mutu <input type="number" name="extra_bad" value="{{ old('extra_bad', 0) }}" min="0" max="10" required></label>
        <button type="submit">Jalankan</button>
    </form>
    @if ($errors->any() && ! $errors->has('engine'))
        <p class="err">{{ $errors->first() }}</p>
    @endif
</div>
@endcan

@can('view-twin-full')
<div class="card">
    <h2>Run terbaru</h2>
    @if ($runs->isEmpty())
        <p>Belum ada run.</p>
    @else
        <table>
            <thead><tr><th>#</th><th>Config</th><th>Skenario</th><th>Status</th><th>Seed</th><th>Truk</th><th>FG (t)</th><th>Tunggu truk (rata-rata, mnt)</th><th>Tunggu lab</th><th>CIP darurat</th><th>False accept</th><th><span class="sr-only">Aksi</span></th></tr></thead>
            <tbody>
            @foreach ($runs as $r)
                <tr>
                    <td>{{ $r->id }}@if ($r->kind === 'simulation') <small title="Pratinjau dampak dari run #{{ $r->parent_run_id }}">Pratinjau dari #{{ $r->parent_run_id }}</small>@elseif ($r->kind === 'campaign') <small>Operasi</small>@endif</td>
                    <td>{{ $r->config }}</td>
                    <td>{{ config('twin.scenarios')[$r->scenario] ?? $r->scenario }}</td>
                    <td>{{ $r->status }}</td>
                    <td>{{ $r->seed }}</td>
                    <td>{{ $r->kpi['trucks'] ?? '-' }}</td>
                    <td>{{ isset($r->kpi['fg_ton']) ? \App\Support\Volume::l($r->kpi['fg_ton']) : '-' }}</td>
                    <td>{{ $r->kpi['truck_wait_min']['mean'] ?? '-' }}</td>
                    <td>{{ $r->kpi['lab_wait_min']['mean'] ?? '-' }}</td>
                    <td>{{ $r->kpi['unscheduled_cip'] ?? '-' }}</td>
                    <td class="{{ ($r->kpi['false_accept'] ?? 0) > 0 ? 'err' : 'ok' }}">{{ $r->kpi['false_accept'] ?? '-' }}</td>
                    <td><a href="{{ route('runs.show', $r->id) }}">Buka</a></td>
                </tr>
            @endforeach
            </tbody>
        </table>
    @endif
</div>
@else
<div class="card"><p>Tampilan terbatas untuk peran Anda.</p></div>
@endcan
@endsection

@push('head')
<style>
    .run-form { display: flex; gap: 16px; align-items: end; flex-wrap: wrap; }
    .run-form label { font-size: 13px; }
    .run-form input, .run-form select { width: 140px; }
</style>
@endpush
