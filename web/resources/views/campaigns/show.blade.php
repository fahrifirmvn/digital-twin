@extends('layouts.app')
@section('title', $campaign->name.' | Operasi')
@if ($current && $current->status === 'running')
    @push('head')<meta http-equiv="refresh" content="4">@endpush
@endif
@push('head')@vite('resources/js/assistant.js')@endpush
@section('content')
@php $status = ['planned' => 'Direncanakan', 'running' => 'Berjalan', 'closed' => 'Ditutup', 'failed' => 'Gagal']; @endphp
<div class="card">
    <h1>{{ $campaign->name }}</h1>
    <button id="cp-open" type="button" aria-expanded="false" aria-controls="cp-drawer">Asisten AI</button>
    <p>
        Konfigurasi {{ $campaign->config }}, skenario {{ config('twin.scenarios')[$campaign->scenario] ?? $campaign->scenario }}, seed {{ $campaign->seed }},
        volume {{ $campaign->params['volume_ton'] ?? '-' }} t/hari.
        @if ($campaign->parent_campaign_id)Cabang dari <a href="{{ route('campaigns.show', $campaign->parent_campaign_id) }}">operasi #{{ $campaign->parent_campaign_id }}</a> hari {{ $campaign->branched_from_day }}.@endif
    </p>
    <p class="{{ $integrity['ok'] ? 'ok' : 'err' }}">
        @if ($integrity['ok'])Rantai checkpoint utuh.@else Rantai checkpoint rusak pada hari {{ $integrity['broken_day'] }}.@endif
    </p>
    @error('engine')<p class="err">{{ $message }}</p>@enderror
    @error('day')<p class="err">{{ $message }}</p>@enderror
</div>

@can('manage-campaign')
@if ($current && in_array($current->status, ['planned', 'failed'], true))
<div class="card">
    <h2>Hari {{ $current->day_no }} ({{ $campaign->dateOf($current->day_no) }})</h2>
    @if ($current->status === 'failed')<p class="err">Hari sebelumnya gagal dijalankan: {{ $current->error }}. Mulai ulang bila perlu.</p>@endif

    <h3 class="sub">Maintenance tangki</h3>
    @if (count($current->carry_in))
        <p>Berlanjut dari hari sebelumnya:</p>
        <ul>@foreach ($current->carry_in as $e)<li>{{ $e['asset'] }}: mati {{ $e['duration_min'] }} menit dari awal hari ({{ $e['reason'] ?? '-' }})</li>@endforeach</ul>
    @endif
    @if (count($current->plan))
        <ul>
        @foreach ($current->plan as $i => $e)
            <li>
                {{ $e['asset'] }}: menit {{ $e['minute'] }}, {{ $e['duration_min'] }} menit. {{ $e['reason'] }} ({{ $e['actor_label'] }})
                <form method="POST" action="{{ route('campaigns.cancel', [$campaign, $i]) }}" style="display:inline">@csrf @method('DELETE')<button type="submit">Batalkan</button></form>
            </li>
        @endforeach
        </ul>
    @else
        <p>Belum ada maintenance dijadwalkan untuk hari ini.</p>
    @endif
    <form method="POST" action="{{ route('campaigns.plan', $campaign) }}" class="run-form">
        @csrf
        <label>Tangki
            <select name="asset">@foreach ($tanks as $t)<option value="{{ $t }}" @selected(old('asset') === $t)>{{ $t }}</option>@endforeach</select>
        </label>
        <label>Mulai (menit ke-, 0 sampai 1439) <input type="number" name="start_min" value="{{ old('start_min', 480) }}" min="0" max="1439" required></label>
        <label>Durasi (menit, 15 sampai 720) <input type="number" name="duration_min" value="{{ old('duration_min', 120) }}" min="15" max="720" required></label>
        <label>Alasan <input type="text" name="reason" value="{{ old('reason') }}" minlength="5" maxlength="200" required></label>
        <button type="submit">Jadwalkan maintenance</button>
    </form>
    @if ($errors->hasAny(['asset', 'start_min', 'duration_min', 'reason']))<p class="err">{{ $errors->first() }}</p>@endif

    <form method="POST" action="{{ route('campaigns.start', $campaign) }}">
        @csrf
        <button type="submit">Mulai hari {{ $current->day_no }}</button>
    </form>
</div>
@endif

<div class="card">
    <form method="POST" action="{{ route('campaigns.autoplay', $campaign) }}">
        @csrf
        <input type="hidden" name="on" value="{{ $campaign->autoplay ? 0 : 1 }}">
        <p>Jalan otomatis: <strong>{{ $campaign->autoplay ? 'aktif' : 'mati' }}</strong>. Bila aktif, hari berikutnya dimulai sendiri setelah hari berjalan ditutup.</p>
        <button type="submit">{{ $campaign->autoplay ? 'Matikan' : 'Aktifkan' }}</button>
    </form>
</div>
@endcan

@if ($current && $current->status === 'running')
<div class="card"><p>Hari {{ $current->day_no }} sedang berjalan (run #{{ $current->run_id }}).
    <a href="{{ route('runs.twin', $current->run_id) }}">Tonton langsung</a>. Halaman ini diperbarui otomatis.</p></div>
@endif

<div class="card">
    <h2>Hari yang sudah berjalan</h2>
    <table>
        <thead><tr><th>Hari</th><th>Tanggal</th><th>Status</th><th>Truk</th><th>FG (t)</th><th>CIP darurat</th><th>False accept</th><th>Hash</th><th><span class="sr-only">Aksi</span></th></tr></thead>
        <tbody>
        @foreach ($days->sortByDesc('day_no') as $d)
            @php $k = $d->status === 'closed' ? ($d->snapshot()['kpi'] ?? []) : []; @endphp
            <tr>
                <td>{{ $d->day_no }}</td>
                <td>{{ $campaign->dateOf($d->day_no) }}</td>
                <td>{{ $status[$d->status] ?? $d->status }}</td>
                <td>{{ $k['trucks'] ?? '-' }}</td>
                <td>{{ isset($k['fg_ton']) ? \App\Support\Volume::l($k['fg_ton']) : '-' }}</td>
                <td>{{ $k['unscheduled_cip'] ?? '-' }}</td>
                <td class="{{ ($k['false_accept'] ?? 0) > 0 ? 'err' : '' }}">{{ $k['false_accept'] ?? '-' }}</td>
                <td class="mono">{{ $d->hash ? substr($d->hash, 0, 10) : '-' }}</td>
                <td>
                    @if ($d->run_id)
                        <a href="{{ route('runs.replay', $d->run_id) }}">Putar ulang</a>
                    @endif
                    @if ($d->status === 'closed')
                        @can('manage-campaign')
                        <form method="POST" action="{{ route('campaigns.branch', $campaign) }}" style="display:inline">@csrf<input type="hidden" name="day" value="{{ $d->day_no }}"><button type="submit">Pulihkan sebagai cabang</button></form>
                        @endcan
                    @endif
                </td>
            </tr>
        @endforeach
        </tbody>
    </table>
</div>
@include('runs._drawer', ['plain' => true])
@endsection
