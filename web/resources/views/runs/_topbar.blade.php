@php
    $active = $active ?? 'dashboard';
    $q = isset($run) ? ['run' => $run->id] : [];
@endphp
<header class="tw-topbar">
    <a class="tw-brand" href="{{ route('dashboard', $q) }}" title="Beranda">
        <span class="tw-logo" aria-hidden="true">L</span>
        <span class="tw-brand-name">LactaTwin</span>
    </a>
    <nav class="tw-switch" aria-label="Tampilan">
        <a href="{{ route('dashboard', $q) }}" @if ($active === 'dashboard') aria-current="page" @endif>Dashboard</a>
        <a href="{{ route('twin', $q) }}" @if ($active === 'twin') aria-current="page" @endif>Digital Twin</a>
        <a href="{{ route('maps', $q) }}" @if ($active === 'maps') aria-current="page" @endif>Maps</a>
    </nav>
    @isset($run)
        @php
            $day = $run->day_result['day'] ?? null;
            $date = $run->day_result['summary']['date'] ?? null;
            $dayLabel = $day ? 'Hari '.$day.($date ? ' · '.\Illuminate\Support\Carbon::parse($date)->locale('id')->translatedFormat('j M Y') : '') : 'Run #'.$run->id;
        @endphp
        <span class="tw-runinfo">
            @if ($daysMenu ?? false)
                <button id="run-day" class="tw-daychip" type="button" popovertarget="tw-days" title="Riwayat hari">{{ $dayLabel }}</button>
            @else
                <b class="tw-daychip">{{ $dayLabel }}</b>
            @endif
            <span id="run-status" class="tw-pill">{{ $staticStatus ?? 'memuat' }}</span>
        </span>
    @endisset
    <div class="tw-topbar-tools">
        @stack('topbar-tools')
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
