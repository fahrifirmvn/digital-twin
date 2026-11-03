@extends('layouts.app')
@section('title', 'Bangun pabrik | LactOS')
@section('bare', '1')

@push('head')
<meta name="csrf-token" content="{{ csrf_token() }}">
@vite('resources/js/build.js')
@endpush

@push('topbar-tools')
    <a id="tw-minimize" class="tw-btn" href="{{ route('twin') }}" data-icon="minimize" data-icon-size="18" title="Kembali ke Digital Twin (Esc)"><span>Kembali</span></a>
@endpush

@section('content')
<div id="tw" class="tw tw-twin tw-build" data-theme="light" data-layouts="{{ json_encode($layouts) }}" data-save-url="{{ route('layouts.store') }}" data-delete-url="{{ url('/layouts') }}">
    @include('runs._topbar', ['active' => 'twin', 'runsLink' => false])

    <main id="tw-stage" class="tw-stage" aria-label="Mode membangun pabrik">
        <div id="twin3d" class="tw-view" role="img" aria-label="Pratinjau denah pabrik 3D"></div>
        <p id="b-nogl" class="tw-gm-note" role="status" hidden>3D tidak tersedia (WebGL). Daftar modul tetap bisa diatur dan dijalankan.</p>

        <section class="tw-card tw-build-plant" data-collapse="build-plant" aria-labelledby="b-h-plant">
            <h2 id="b-h-plant">Susunan pabrik</h2>
            <p class="tw-hint">Jumlah tiap modul 1 sampai 8. Perubahan memengaruhi simulasi baru, tidak mengubah run yang sudah ada.</p>
            <div id="b-fields" class="tw-sim-form"></div>
            <p id="b-summary" class="tw-hint" role="status"></p>
            <div class="tw-sim-form">
                <label>Denah tersimpan
                    <select id="b-saved"><option value="">Pabrik bawaan</option></select>
                </label>
                <div class="tw-iv-actions">
                    <button id="b-reset" class="tw-iv-btn" type="button">Kembalikan bawaan</button>
                    <button id="b-delete" class="tw-iv-btn danger" type="button" hidden>Hapus denah</button>
                </div>
                <label>Nama denah
                    <input id="b-name" type="text" maxlength="60" placeholder="mis. Bay tambahan">
                </label>
                <button id="b-save" class="tw-iv-btn primary" type="button">Simpan denah</button>
                <p id="b-err" class="tw-sim-err" role="alert"></p>
            </div>
        </section>

        <section class="tw-card tw-build-run" data-collapse="build-run" aria-labelledby="b-h-run">
            <h2 id="b-h-run">Jalankan simulasi</h2>
            @error('engine')<p class="tw-sim-err" role="alert">{{ $message }}</p>@enderror
            @if ($errors->any() && ! $errors->has('engine'))<p class="tw-sim-err" role="alert">{{ $errors->first() }}</p>@endif
            <form id="b-run" class="tw-sim-form" method="POST" action="{{ route('runs.store') }}">
                @csrf
                <input type="hidden" name="go" value="twin">
                <div id="b-plant-inputs"></div>
                <label>Konfigurasi
                    <select name="config">
                        @foreach (config('twin.configs') as $k => $label)
                            <option value="{{ $k }}" @selected(old('config', 'B') === $k)>{{ $label }}</option>
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
                <div class="tw-sim-args">
                    <label>Seed <input type="number" name="seed" value="{{ old('seed', 1) }}" min="0" required></label>
                    <label>Volume (ton; 1 t = 971 L) <input type="number" name="volume_ton" value="{{ old('volume_ton', 320) }}" min="50" max="600" step="10" required></label>
                </div>
                <label>Truk di luar batas mutu <input type="number" name="extra_bad" value="{{ old('extra_bad', 0) }}" min="0" max="10" required></label>
                <button class="tw-iv-btn primary" type="submit">Jalankan dengan susunan ini</button>
            </form>
            <p class="tw-hint">Seluruh data adalah simulasi. Hasil dibuka di Digital Twin begitu run selesai.</p>
        </section>
    </main>
</div>
@endsection
