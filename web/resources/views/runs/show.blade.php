@extends('layouts.app')
@section('title', "Dashboard Run #{$run->id} | LactOS")
@section('bare', '1')

@push('head')
@vite('resources/js/dashboard.js')
@endpush

@push('topbar-tools')
    <a class="tw-btn" href="#whatif" data-icon="layers" data-icon-size="18"><span>What-if</span></a>
    <button id="cp-open" class="tw-btn primary" type="button" data-icon="sparkles" data-icon-size="18" aria-controls="cp-drawer" aria-expanded="false"><span>Tanya Asisten AI</span></button>
@endpush

@section('content')
@php
    $proposed = $versions->where('status', 'proposed');
@endphp
<div id="tw" class="tw tw-dash" data-theme="light" data-replay-url="{{ route('runs.replay', $run) }}" data-run-id="{{ $run->id }}">
    @include('runs._topbar', ['active' => 'monitoring'])

    <main class="dash">
        <div class="dash-head">
            <div>
                <h1>Dashboard Monitoring</h1>
                <p class="muted">
                    Konfigurasi {{ $run->config_snapshot['config'] ?? 'A' }}
                    ({{ config('twin.configs')[$run->config_snapshot['config'] ?? 'A'] ?? '' }}).
                    Skenario: {{ config('twin.scenarios')[$run->config_snapshot['scenario'] ?? 'normal'] ?? '-' }}.
                    Seed {{ $run->seed }}, {{ isset($run->config_snapshot['params']['volume_ton']) ? \App\Support\Volume::l($run->config_snapshot['params']['volume_ton']) : '?' }}/hari,
                    {{ $run->config_snapshot['params']['extra_bad'] ?? 0 }} truk di luar batas mutu.
                </p>
            </div>
            <div class="tw-dock tw-dock-inline" role="group" aria-label="Kontrol waktu simulasi">
                <button id="play" class="tw-play" type="button"></button>
                <select id="speed" aria-label="Kecepatan">
                    <option value="5">5 mnt/dtk</option>
                    <option value="10" selected>10 mnt/dtk</option>
                    <option value="30">30 mnt/dtk</option>
                    <option value="60">60 mnt/dtk</option>
                    <option value="120">120 mnt/dtk</option>
                    <option value="300">300 mnt/dtk</option>
                    <option value="600">600 mnt/dtk</option>
                </select>
                <input id="scrub" type="range" min="0" max="1440" value="0" aria-label="Waktu simulasi">
                <strong id="clock" class="mono">00:00</strong>
            </div>
        </div>

        <p id="run-msg" class="err" role="alert"></p>
        @if (session('status'))
            <div class="tw-card ok" role="status">{{ session('status') }}</div>
        @endif
        @if ($errors->any())
            <div class="tw-card err" role="alert">{{ $errors->first() }}</div>
        @endif

        <section class="dash-kpis" aria-label="Ringkasan KPI langsung">
            <div class="tw-card kpi"><span>Waktu tunggu rata-rata</span><b id="k-wait">-</b><small>mnt, truk yang sudah bongkar</small></div>
            <div class="tw-card kpi"><span>Truk di area tunggu</span><b id="k-waiting">0</b><small>antre, uji, rilis</small></div>
            <div class="tw-card kpi"><span>Dalam perjalanan</span><b id="k-transit">0</b><small>belum tiba di pabrik</small></div>
            <div class="tw-card kpi"><span>Antrean uji lab</span><b id="k-lab">0</b><small id="k-lab-sub">sedang diuji: 0</small></div>
            <div class="tw-card kpi"><span>Kepatuhan gate SOP</span><b id="k-gate">-</b><small id="k-gate-sub">belum ada keputusan</small></div>
            <div class="tw-card kpi"><span>Selesai bongkar</span><b id="k-unloaded">0</b><small id="k-fg">0 L FG keluar</small></div>
        </section>

        <div class="dash-grid">
            <div class="dash-col">
                <section class="tw-card" aria-labelledby="h-gantt">
                    <h2 id="h-gantt">Jadwal bongkar dan aset</h2>
                    <div class="legend">
                        <span><i style="background:#2563eb"></i>aktif / bongkar</span>
                        <span><i style="background:#16a34a"></i>tangki terisi</span>
                        <span><i style="background:#f59e0b"></i>CIP</span>
                        <span><i style="background:#94a3b8"></i>antre</span>
                        <span><i style="background:#a78bfa"></i>menunggu analis</span>
                        <span><i style="background:#7c3aed"></i>uji lab</span>
                        <span><i style="background:#14b8a6"></i>rilis, menunggu tangki</span>
                    </div>
                    <div class="gantt-wrap" tabindex="0" aria-label="Gantt, dapat digulir"><canvas id="gantt" aria-label="Gantt aset dan truk"></canvas></div>
                </section>

                <section class="tw-card" aria-labelledby="h-trucks">
                    <h2 id="h-trucks">Daftar truk</h2>
                    <div class="tw-table-scroll tall" tabindex="0" aria-label="Daftar truk, dapat digulir">
                        <table>
                            <thead><tr><th>Truk</th><th>Asal</th><th>Volume</th><th>Status</th><th>Bay</th><th>Tunggu</th></tr></thead>
                            <tbody id="d-trucks"></tbody>
                        </table>
                    </div>
                </section>

                <section class="tw-card" aria-labelledby="h-kpi">
                    <h2 id="h-kpi">KPI hasil run</h2>
                    <table><tbody id="kpi-body"></tbody></table>
                    <p class="muted">Baseline FIFO. Perbandingan dengan penjadwalan optimal ada pada bagian What-if.</p>
                </section>
            </div>

            <div class="dash-col">
                <section class="tw-card" aria-labelledby="h-decide">
                    <h2 id="h-decide">Perlu keputusan</h2>
                    @foreach ($proposed as $v)
                        <div class="row-item">
                            <div><b>Jadwal v{{ $v->version }}</b><small>Usulan {{ $v->created_by }}, {{ count($v->plan['trucks'] ?? []) }} truk</small></div>
                            @can('approve-schedule')
                                <button type="button" class="tw-btn" data-approve data-run="{{ $run->id }}" data-version="{{ $v->version }}">Setujui</button>
                            @endcan
                        </div>
                    @endforeach
                    <ul id="d-decisions" class="plain"></ul>
                    <p id="d-decisions-empty" class="tw-hint">Tidak ada truk ditahan atau ditolak.</p>
                </section>

                <section class="tw-card" aria-labelledby="h-prep">
                    <h2 id="h-prep">Persiapan uji mutu</h2>
                    <ul id="d-prep" class="plain"></ul>
                    <p id="d-prep-empty" class="tw-hint">Tidak ada truk di tahap uji.</p>
                </section>

                <section class="tw-card" aria-labelledby="h-preview">
                    <h2 id="h-preview">Pratinjau twin</h2>
                    <div class="preview"><canvas id="twin-preview" aria-label="Pratinjau denah pabrik"></canvas></div>
                    <a class="tw-btn primary block" href="{{ route('runs.twin', $run) }}" data-icon="box" data-icon-size="18"><span>Buka Digital Twin</span></a>
                </section>

                <section class="tw-card" aria-labelledby="h-alerts">
                    <h2 id="h-alerts">Peringatan</h2>
                    <ul id="d-alerts" class="plain"></ul>
                    <p id="d-alerts-empty" class="tw-hint">Belum ada peringatan.</p>
                </section>
            </div>
        </div>

        @if ($run->ai_result)
            @include('runs._ai', ['ai' => $run->ai_result])
        @endif

        <section id="whatif" class="whatif" aria-label="What-if">
            <h2>What-if</h2>
            @include('runs._params')
            @if (count($comparison) > 0)
                @include('runs._comparison')
            @else
                <div class="tw-card"><p class="muted">Belum ada konfigurasi lain untuk hari yang sama. Jalankan konfigurasi berbeda dari Beranda, atau minta Asisten AI mengusulkan run.</p></div>
            @endif
            @if ($versions->isNotEmpty())
                @include('runs._schedule')
            @endif
        </section>
    </main>

    @include('runs._drawer')
</div>
@endsection
