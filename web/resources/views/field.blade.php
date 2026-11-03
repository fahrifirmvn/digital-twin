@extends('layouts.app')
@section('title', $mode === 'operator' ? 'Operator View' : 'Check-in truk')

@push('head')
<meta name="csrf-token" content="{{ csrf_token() }}">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0b3d5c">
<link rel="icon" type="image/png" href="/icons/icon-192.png">
@vite('resources/js/field.js')
@endpush

@section('content')
<div id="field" data-mode="{{ $mode }}" data-user="{{ auth()->id() }}"
     data-manifest-url="{{ route('field.manifest') }}" data-confirm-url="{{ route('field.confirm') }}"
     data-token="{{ csrf_token() }}">
    <div class="card">
        <h2>{{ $mode === 'operator' ? 'Operator View' : 'Check-in kedatangan truk' }}</h2>
        <p id="field-status" role="status">Memuat...</p>
        <button type="button" id="field-sync" hidden>Kirim sekarang</button>
        <p id="field-empty" hidden>Belum ada run selesai. Minta PPIC menjalankan simulasi.</p>
    </div>

    <div id="field-content" hidden>
        @if ($mode === 'operator')
            <div class="card">
                <h3>Jam simulasi: <span id="sim-clock" class="mono">--:--</span></h3>
                <input id="sim-slider" type="range" min="0" max="100" value="0" aria-label="Jam simulasi">
                <p>Status aset dan tugas dihitung dari rencana jadwal pada jam simulasi ini (perkiraan; rencana tidak memuat durasi aktual).</p>
                <h4>Status aset</h4>
                <table><thead><tr><th>Aset</th><th>Status</th></tr></thead><tbody id="assets-body"></tbody></table>
                <h4>Tugas aktif dan berikutnya</h4>
                <p id="tasks-empty" hidden>Run ini tidak punya rencana jadwal (konfigurasi tanpa optimizer), jadi tidak ada tugas serah terima.</p>
                <table><thead><tr><th>Mulai</th><th>Truk</th><th>Tugas</th><th>Fase</th><th>Serah terima</th></tr></thead><tbody id="tasks-body"></tbody></table>
            </div>
        @endif
        <div class="card">
            <h3>Truk</h3>
            <table><thead><tr><th>Truk</th><th>Asal</th><th>ETA (UTC)</th><th>Check-in</th></tr></thead><tbody id="trucks-body"></tbody></table>
        </div>
    </div>
</div>
@endsection
