@php
    $active = $active ?? 'dashboard';
    $q = isset($run) ? ['run' => $run->id] : [];
@endphp
<header class="tw-topbar">
    <a class="tw-brand" href="{{ route('dashboard', $q) }}" title="Beranda">
        <span class="tw-logo" aria-hidden="true">L</span>
        <span class="tw-brand-name">LactOS Twin</span>
    </a>
    <nav class="tw-switch" aria-label="Tampilan">
        <a href="{{ route('dashboard', $q) }}" @if ($active === 'dashboard') aria-current="page" @endif>Dashboard</a>
        <a href="{{ route('twin', $q) }}" @if ($active === 'twin') aria-current="page" @endif>Digital Twin</a>
        <a href="{{ route('maps', $q) }}" @if ($active === 'maps') aria-current="page" @endif>Maps</a>
    </nav>
    <span class="tw-demo" title="Seluruh data adalah data simulasi">DEMO</span>
    @isset($run)
        @php $badge = $run->modeBadge(); @endphp
        <span id="run-mode" class="tw-mode" data-mode="{{ $badge['key'] }}" title="Asal data: LIVE = run sedang berjalan, SIMULASI = cabang what-if, DATA CONTOH = hasil run yang sudah selesai">{{ $badge['label'] }}</span>
        <span class="tw-runinfo">Run #{{ $run->id }} <span id="run-status" class="tw-pill">{{ $staticStatus ?? 'memuat' }}</span>@if ($run->isSimulation() && $run->parent_run_id) dari <a href="{{ route('twin', ['run' => $run->parent_run_id]) }}">#{{ $run->parent_run_id }}</a>@endif</span>
    @endisset
    <div class="tw-topbar-tools">
        @stack('topbar-tools')
        @if ($runsLink ?? true)
            <a class="tw-btn" href="{{ route('runs.index') }}" title="Daftar run" data-icon="replay" data-icon-size="18"><span>Daftar run</span></a>
        @endif
        <button id="tw-theme" class="tw-ico" type="button"></button>
        @auth
            <form method="POST" action="{{ route('logout') }}" class="tw-user">
                @csrf
                <span class="tw-user-name">{{ auth()->user()->name }} <small>{{ auth()->user()->role->label() }}</small></span>
                <button class="tw-ico" type="submit" aria-label="Keluar" title="Keluar" data-icon="log-out"></button>
            </form>
        @endauth
    </div>
</header>
