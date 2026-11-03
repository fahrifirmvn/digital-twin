<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title', 'LactaTwin')</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 0; background: #f4f6f8; color: #1d2733; }
        header { background: #0b3d5c; color: #fff; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
        header a { color: #cfe8f7; margin-right: 16px; text-decoration: none; }
        main { max-width: 960px; margin: 24px auto; padding: 0 24px; }
        .card > h1 { font-size: 1.5em; }
        .card h2.sub { font-size: 1.17em; }
        .card h3.sub { font-size: 1em; }
        .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        .card { position: relative; overflow-x: auto; background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 16px; }
        .badge { background: #f5a623; color: #000; border-radius: 4px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3e8ee; }
        td.mono { font-family: ui-monospace, monospace; }
        .ok { color: #1a7f37; } .err { color: #c62828; }
        input { padding: 8px; width: 100%; box-sizing: border-box; margin: 4px 0 12px; }
        button { padding: 8px 16px; cursor: pointer; }
    </style>
    @stack('head')
</head>
<body>
@hasSection('bare')
    @yield('content')
@else
@auth
    <header>
        <nav>
            <a href="{{ route('dashboard') }}">Dashboard</a>
            @can('view-twin-full')<a href="{{ route('twin') }}">Digital Twin</a><a href="{{ route('campaigns.index') }}">Operasi</a>@endcan
            @can('check-in-truck')<a href="{{ route('driver') }}">Check-in truk</a>@endcan
            @can('confirm-handoff')<a href="{{ route('operator') }}">Operator</a>@endcan
            @can('view-trace')<a href="{{ route('trace') }}">Traceability</a>@endcan
            @can('view-audit-log')<a href="{{ route('audit') }}">Audit Log</a>@endcan
        </nav>
        <form method="POST" action="{{ route('logout') }}">
            @csrf
            <span>{{ auth()->user()->name }} ({{ auth()->user()->role->label() }})</span>
            <button type="submit">Keluar</button>
        </form>
    </header>
@endauth
<main>
    <p>
    @yield('content')
</main>
@endif
</body>
</html>
