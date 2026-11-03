@extends('layouts.app')
@section('title', 'Operasi | LactaTwin')
@section('content')
<h1 class="sr-only">Operasi harian</h1>

@can('manage-campaign')
<div class="card">
    <h2>Mulai operasi baru</h2>
    <p>Pabrik berjalan hari demi hari. Tiap hari ditutup dengan checkpoint yang bisa diputar ulang atau dipulihkan sebagai cabang.</p>
    <form method="POST" action="{{ route('campaigns.store') }}" class="run-form">
        @csrf
        <label>Nama <input type="text" name="name" value="{{ old('name', 'Operasi baru') }}" minlength="3" maxlength="80" required></label>
        <label>Tanggal hari pertama <input type="date" name="start_date" value="{{ old('start_date', now()->toDateString()) }}" required></label>
        <label>Konfigurasi
            <select name="config">
                @foreach (config('twin.configs') as $k => $label)
                    <option value="{{ $k }}" @selected(old('config', 'D') === $k)>{{ $label }}</option>
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
        <label>Seed operasi <input type="number" name="seed" value="{{ old('seed', 1) }}" min="0" max="2147483647" required></label>
        <label>Volume harian (ton) <input type="number" name="volume_ton" value="{{ old('volume_ton', 320) }}" min="50" max="600" step="10" required></label>
        <label>Truk di luar batas mutu per hari <input type="number" name="extra_bad" value="{{ old('extra_bad', 0) }}" min="0" max="10" required></label>
        <label>Kecepatan
            <select name="speed">
                @foreach (config('twin.campaign.speeds') as $k => $label)
                    <option value="{{ $k }}" @selected((string) old('speed', '') === (string) $k)>{{ $label }}</option>
                @endforeach
            </select>
        </label>
        <button type="submit">Buat operasi</button>
    </form>
    @if ($errors->any())<p class="err">{{ $errors->first() }}</p>@endif
</div>
@endcan

<div class="card">
    <h2>Operasi</h2>
    @if ($campaigns->isEmpty())
        <p>Belum ada operasi.</p>
    @else
        <table>
            <thead><tr><th>#</th><th>Nama</th><th>Konfigurasi</th><th>Skenario</th><th>Hari berjalan</th><th>Hari ditutup</th><th>Asal</th><th><span class="sr-only">Aksi</span></th></tr></thead>
            <tbody>
            @foreach ($campaigns as $c)
                <tr>
                    <td>{{ $c->id }}</td>
                    <td>{{ $c->name }}</td>
                    <td>{{ $c->config }}</td>
                    <td>{{ config('twin.scenarios')[$c->scenario] ?? $c->scenario }}</td>
                    <td>{{ $c->current_day }}</td>
                    <td>{{ $c->closed_days }}</td>
                    <td>@if ($c->parent_campaign_id)cabang #{{ $c->parent_campaign_id }} hari {{ $c->branched_from_day }}@else-@endif</td>
                    <td><a href="{{ route('campaigns.show', $c) }}">Buka</a></td>
                </tr>
            @endforeach
            </tbody>
        </table>
    @endif
</div>
@endsection
