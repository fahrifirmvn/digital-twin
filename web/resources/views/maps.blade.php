@extends('layouts.app')
@section('title', "Maps Run #{$run->id} | LactaTwin")
@section('bare', '1')

@push('head')
@vite('resources/js/maps.js')
@endpush

@push('topbar-tools')
    <a id="tw-minimize" class="tw-btn" href="{{ route('dashboard', ['run' => $run->id]) }}" data-icon="minimize" data-icon-size="18" title="Kembali ke Dashboard (Esc)"><span>Perkecil</span></a>
    <button id="cp-open" class="tw-btn primary" type="button" data-icon="sparkles" data-icon-size="18" aria-controls="cp-drawer" aria-expanded="false"><span>Tanya Asisten AI</span></button>
@endpush

@section('content')
<div id="tw" class="tw tw-twin tw-maps" data-theme="light" data-replay-url="{{ route('runs.replay', $run) }}" data-run-id="{{ $run->id }}" data-twin-url="{{ route('twin', ['run' => $run->id]) }}">
    @include('runs._topbar', ['active' => 'maps'])

    <main id="tw-stage" class="tw-stage" aria-label="Peta truk menuju gerbang">
        <h1 class="sr-only">Peta truk menuju gerbang</h1>
        <div id="map" class="tw-map tw-geomap" role="application" aria-label="Peta truk menuju gerbang pabrik; rincian ada pada daftar truk" hidden></div>
        <p id="m-offline" class="tw-gm-note tw-gm-offline" role="status" hidden>Peta dasar tidak dapat dimuat (perlu internet). Jalur, geofence, dan truk tetap tampil.</p>

        <p id="tw-loading" class="tw-loading" role="status"><span id="run-msg">Memuat peta…</span></p>

        <section class="tw-card tw-stats" data-collapse="maps-stats" aria-label="Ringkasan perjalanan">
            <h2>Menuju Gerbang</h2>
            <div class="tw-stat-grid">
                <div class="tw-stat"><b id="m-inbound">0</b><span>truk di jalan</span></div>
                <div class="tw-stat"><b id="m-next">-</b><span>ETA terdekat</span></div>
                <div class="tw-stat"><b id="m-fence">0</b><span>di geofence</span></div>
                <div class="tw-stat"><b id="m-arrived">0</b><span>sudah tiba</span></div>
            </div>
            <p id="m-nodata" class="tw-hint" hidden>Belum ada data perjalanan untuk hari ini.</p>
        </section>

        <div class="tw-rail">
            <section class="tw-card tw-inbound" data-collapse="maps-inbound" aria-labelledby="h-inbound">
                <h2 id="h-inbound">Truk menuju gerbang</h2>
                <div class="tw-table-scroll">
                    <table>
                        <thead><tr><th>Plat</th><th>Asal</th><th>ETA</th></tr></thead>
                        <tbody id="m-rows"></tbody>
                    </table>
                </div>
            </section>
        </div>

        <section id="m-card" class="tw-card tw-gm-card" aria-live="polite" hidden></section>

        <div class="tw-dock" role="group" aria-label="Kontrol waktu">
            <button id="play" class="tw-play" type="button"></button>
            <select id="speed" aria-label="Kecepatan">
                <option value="2">1x</option>
                <option value="10" selected>5x</option>
                <option value="40">20x</option>
            </select>
            <input id="scrub" type="range" min="0" max="1440" value="0" aria-label="Waktu">
            <strong id="clock" class="mono">00:00</strong>
        </div>
    </main>

    @include('runs._drawer')
</div>
@endsection
