@extends('layouts.app')
@section('title', "Digital Twin Run #{$run->id} | LactOS")
@section('bare', '1')
@php
    $canSim = auth()->user()->can('simulate');
    $cmd = config('twin.commands');
@endphp

@push('head')
<meta name="csrf-token" content="{{ csrf_token() }}">
@vite('resources/js/twin.js')
@endpush

@push('topbar-tools')
    @if ($canSim || $run->isSimulation())
        <div class="tw-seg" role="group" aria-label="Mode">
            <button id="mode-watch" type="button" aria-pressed="true" title="Memantau run apa adanya">Pantau</button>
            <button id="mode-sim" type="button" aria-pressed="false" title="Uji kejadian what-if tanpa mengubah jadwal nyata">Simulasi</button>
        </div>
    @endif
    <button id="cp-open" class="tw-btn primary" type="button" data-icon="sparkles" data-icon-size="18" aria-controls="cp-drawer" aria-expanded="false" title="Tanya Asisten AI"><span>Tanya Asisten AI</span></button>
    <button class="tw-ico" type="button" popovertarget="tw-more" data-icon="more" aria-label="Menu lainnya" title="Menu lainnya"></button>
    <div id="tw-more" class="tw-pop" popover>
        <label class="tw-pop-row">Kualitas grafis 3D
            <select id="tw-quality">
                <option value="auto">Otomatis</option>
                <option value="low">Rendah</option>
                <option value="medium">Sedang</option>
                <option value="high">Tinggi</option>
            </select>
        </label>
        <hr>
        <a id="tw-minimize" class="tw-pop-item" href="{{ route('dashboard', ['run' => $run->id]) }}" data-icon="minimize" data-icon-size="18">Kembali ke Dashboard <kbd>Esc</kbd></a>
        <a class="tw-pop-item" href="{{ route('runs.show', $run) }}#whatif" data-icon="layers" data-icon-size="18">Perbandingan what-if</a>
        <a class="tw-pop-item" href="{{ route('runs.index') }}" data-icon="replay" data-icon-size="18">Daftar run</a>
        @can('build-layout')
            <a class="tw-pop-item" href="{{ route('build') }}" data-icon="layers" data-icon-size="18">Bangun pabrik</a>
        @endcan
    </div>
@endpush

@section('content')
<div id="tw" class="tw tw-twin" data-theme="light" data-mode="pantau" data-replay-url="{{ route('runs.replay', $run) }}" data-run-id="{{ $run->id }}" data-plant="{{ json_encode((object) $run->plant()) }}" data-simulation="{{ $run->isSimulation() ? '1' : '0' }}" data-anomaly="{{ json_encode($run->ai_result['anomaly'] ?? null) }}">
    @include('runs._topbar', ['active' => 'twin', 'runsLink' => false])

    <main id="tw-stage" class="tw-stage" aria-label="Digital twin pabrik">
        <div id="twin3d" class="tw-view" hidden></div>
        <canvas id="twin" class="tw-view" aria-label="Twin Canvas pabrik" hidden></canvas>
        <div id="tw-pins" class="tw-pins"></div>

        <p id="tw-loading" class="tw-loading" role="status"><span id="run-msg">Memuat simulasi...</span></p>

        <section class="tw-card tw-stats" data-collapse="twin-stats" aria-label="Statistik langsung">
            <h2>Statistik Langsung</h2>
            <div class="tw-stat-grid">
                <div class="tw-stat"><b id="s-waiting">0</b><span>truk di area tunggu</span></div>
                <div class="tw-stat"><b id="s-wait">-</b><span>rata-rata tunggu (mnt)</span></div>
                <div class="tw-stat"><b id="s-lab">0</b><span>antrean uji lab</span></div>
                <div class="tw-stat" id="s-holds-box"><b id="s-holds">0</b><span>gate TAHAN</span></div>
                <div class="tw-stat"><b id="s-inbound">0</b><span>menuju gerbang</span></div>
                <div class="tw-stat" title="Truk yang plat nomornya terbaca di gerbang"><b id="s-detected">0</b><span>terdeteksi</span></div>
            </div>
            <p class="tw-hint"><a href="{{ route('maps', ['run' => $run->id]) }}">Lihat truk menuju gerbang di Maps</a></p>
        </section>

        <section class="tw-card tw-track" data-collapse="twin-track" aria-label="Pelacakan truk">
            <h2>Pelacakan Truk</h2>
            <div id="tw-track-body" class="tw-track-body"><p class="tw-hint">Pilih truk pada peta atau tabel untuk melihat tahapnya.</p></div>
        </section>

        <div class="tw-card tw-controls" role="group" aria-label="Kontrol peta">
            <div class="tw-controls-head">
                <button class="tw-grip" type="button" aria-label="Geser kontrol peta: seret, atau pakai tombol panah; Home mengembalikan posisi" title="Seret untuk memindahkan, klik dua kali untuk mengembalikan"></button>
                <button class="tw-ctl-toggle" type="button" aria-expanded="true" data-icon="chevron-up" data-icon-size="16"></button>
            </div>
            <div class="tw-seg tw-seg-v" role="group" aria-label="Jenis tampilan">
                <button id="view-3d" type="button" aria-pressed="false">3D</button>
                <button id="view-2d" type="button" aria-pressed="false">2D</button>
            </div>
            <div class="tw-seg tw-seg-v tw-seg-z" role="group" aria-label="Zona pabrik (kamera; Proses membuka atap bangunan)">
                <button type="button" data-zone="all" aria-pressed="true" title="Seluruh pabrik">Semua</button>
                <button type="button" data-zone="intake" aria-pressed="false" title="Penerimaan: gerbang, area tunggu, lab, dan depan bay">Terima</button>
                <button type="button" data-zone="process" aria-pressed="false" title="Masuk bangunan produksi: bay sampai filling (klik 2x bangunan; Esc untuk keluar)">Proses</button>
            </div>
            <button id="cm-in" class="tw-ico" type="button" data-icon="zoom-in" aria-label="Zoom masuk" title="Zoom masuk"></button>
            <button id="cm-out" class="tw-ico" type="button" data-icon="zoom-out" aria-label="Zoom keluar" title="Zoom keluar"></button>
            <button id="cm-rot" class="tw-ico" type="button" data-icon="rotate-3d" aria-label="Putar tampilan" title="Putar tampilan"></button>
            <button id="cm-reset" class="tw-ico" type="button" data-icon="locate" aria-label="Pusatkan peta" title="Pusatkan peta"></button>
        </div>

        <div class="tw-rail">
            <section id="tw-sheet" class="tw-card tw-sheet" role="dialog" aria-labelledby="tw-sheet-title" hidden>
                <div class="tw-sheet-head">
                    <h2 id="tw-sheet-title"></h2>
                    <button id="tw-sheet-close" class="tw-ico" type="button" aria-label="Tutup detail" data-icon="x"></button>
                </div>
                <span id="tw-sheet-chip" class="tw-status"></span>
                <dl id="tw-sheet-rows"></dl>
                <section id="tw-sheet-gates" hidden>
                    <h3>Gate mutu</h3>
                    <ul></ul>
                </section>
            </section>

            <section id="tw-agent" class="tw-card tw-agent" data-collapse="twin-agent" data-fold-default="1" aria-label="Agen Copilot">
                <h2>Agen Copilot</h2>
                <div id="agent-body" class="tw-agent-body"><p class="tw-hint">Memuat status agen...</p></div>
            </section>

            <section id="tw-sim" class="tw-card tw-sim" data-collapse="twin-sim" aria-label="Simulasi what-if" hidden>
                <h2>Simulasi what-if</h2>
                <p class="tw-hint">Cabang dari run ini dengan seed yang sama. Jadwal nyata tidak berubah, dan setiap perintah tercatat.</p>
                @can('intervene')
                    <form id="iv-form" class="tw-sim-form tw-iv" method="POST" action="{{ route('runs.fork', $run) }}" onsubmit="return false">
                        @csrf
                        <h3>Intervensi PPIC</h3>
                        <p class="tw-hint">Setujui, ubah, atau tolak usulan sistem, atau tahan truk di gerbang. Keputusan berlaku dari jam di penunjuk waktu dan membuka cabang baru. Gate mutu SOP tidak bisa dilewati.</p>
                        <label>Alasan keputusan (wajib, dicatat)
                            <input id="iv-reason" type="text" maxlength="200" autocomplete="off" placeholder="Mis. bay 2 lebih dekat ke lab">
                        </label>
                        <p id="iv-err" class="tw-sim-err" role="alert"></p>
                        <div id="iv-list" class="tw-iv-groups" aria-live="polite"></div>
                    </form>
                @endcan
                @can('simulate')
                    <form id="sim-form" class="tw-sim-form" method="POST" action="{{ route('runs.fork', $run) }}" data-defaults="{{ json_encode($cmd['defaults']) }}">
                        @csrf
                        <h3>Gangguan what-if</h3>
                        <label>Kejadian
                            <select id="sim-kind" name="kind">
                                @foreach ($cmd['kinds'] as $key => $label)
                                    <option value="{{ $key }}">{{ $label }}</option>
                                @endforeach
                            </select>
                        </label>
                        <div class="tw-sim-args">
                            <label data-for="count">Jumlah <input name="count" type="number" step="1" min="{{ $cmd['limits']['count'][0] }}" max="{{ $cmd['limits']['count'][1] }}"></label>
                            <label data-for="duration_min">Durasi (mnt) <input name="duration_min" type="number" step="15" min="{{ $cmd['limits']['duration_min'][0] }}" max="{{ $cmd['limits']['duration_min'][1] }}"></label>
                            <label data-for="asset">Tangki
                                <select name="asset">
                                    @foreach ($cmd['tanks'] as $prefix => $n)
                                        @for ($k = 1; $k <= $n; $k++)
                                            <option value="{{ $prefix }}-{{ $k }}">{{ $prefix }}-{{ $k }}</option>
                                        @endfor
                                    @endforeach
                                </select>
                            </label>
                            <label data-for="factor">Pengali CIP <input name="factor" type="number" step="0.1" min="{{ $cmd['limits']['factor'][0] }}" max="{{ $cmd['limits']['factor'][1] }}"></label>
                        </div>
                        <label>Alasan (dicatat di log)
                            <input name="reason" type="text" required minlength="5" maxlength="200" autocomplete="off" placeholder="Mis. uji ketahanan jadwal siang hari">
                        </label>
                        <input id="sim-minute" name="minute" type="hidden" value="0">
                        <button id="sim-go" class="tw-btn primary block" type="submit"><span>Jalankan dari <b id="sim-at">00:00</b></span></button>
                        <p id="sim-err" class="tw-sim-err" role="alert"></p>
                    </form>
                @endcan
                <div class="tw-sim-body">
                    <div id="sim-score" class="tw-score" role="status" hidden></div>
                    <h3>Log perintah</h3>
                    <ol id="sim-log" class="tw-sim-log"></ol>
                    <h3>Dampak vs dasar</h3>
                    <div id="sim-impact"></div>
                </div>
            </section>

            <section class="tw-card tw-table" data-collapse="twin-table" aria-label="Tabel aset">
                <h2>Aset pabrik</h2>
                <div class="tw-tabs" role="tablist" aria-label="Jenis aset">
                    <button type="button" role="tab" data-tab="bay" aria-selected="true">Bay</button>
                    <button type="button" role="tab" data-tab="silo" aria-selected="false">Silo</button>
                    <button type="button" role="tab" data-tab="proc" aria-selected="false">Proses</button>
                    <button type="button" role="tab" data-tab="lab" aria-selected="false">Lab</button>
                </div>
                <div class="tw-table-scroll">
                    <table><tbody id="tw-rows"></tbody></table>
                </div>
            </section>
        </div>

        <div class="tw-dock" role="group" aria-label="Kontrol waktu simulasi">
            <button id="play" class="tw-play" type="button"></button>
            <button id="jump" class="tw-ico" type="button" data-icon="skip-forward" aria-label="Kejadian berikutnya" title="Kejadian berikutnya"></button>
            <select id="speed" aria-label="Kecepatan">
                <option value="5">5 mnt/dtk</option>
                    <option value="10" selected>10 mnt/dtk</option>
                    <option value="30">30 mnt/dtk</option>
                <option value="60">60 mnt/dtk</option>
                <option value="120">120 mnt/dtk</option>
                <option value="300">300 mnt/dtk</option>
                <option value="600">600 mnt/dtk</option>
            </select>
            <div class="tw-scrub">
                <input id="scrub" type="range" min="0" max="1440" value="0" aria-label="Waktu simulasi">
                <div id="scrub-marks" class="tw-marks" aria-hidden="true"></div>
            </div>
            <strong id="clock" class="mono">00:00</strong>
        </div>

        <p id="view-msg" class="tw-toast" role="status"></p>
    </main>

    @include('runs._drawer')
</div>
@endsection
