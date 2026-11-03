@extends('layouts.app')
@section('title', 'Audit Log | LactOS Digital Twin')
@section('content')
<div class="card">
    <h1>Audit Log</h1>
    @unless ($ready)
        <p class="err" role="status">Audit log memakai trigger PostgreSQL dan tidak tersedia pada database ini.</p>
    @endunless
    <form method="POST" action="{{ route('audit.verify') }}">
        @csrf
        <button type="submit">Verifikasi Integritas</button>
    </form>
    @if (session('verification'))
        <p class="{{ str_starts_with(session('verification'), 'Rantai utuh') ? 'ok' : 'err' }}">{{ session('verification') }}</p>
    @endif
</div>
<div class="card">
    <table>
        <thead><tr><th>#</th><th>Waktu (UTC)</th><th>Aktor</th><th>Aksi</th><th>Hash</th></tr></thead>
        <tbody>
        @foreach ($logs as $log)
            <tr>
                <td>{{ $log->id }}</td>
                <td>{{ $log->occurred_at }}</td>
                <td>{{ $log->actor_type }}{{ $log->actor_id ? ':'.$log->actor_id : '' }}</td>
                <td>{{ $log->action }}</td>
                <td class="mono">{{ substr($log->hash, 0, 12) }}</td>
            </tr>
        @endforeach
        </tbody>
    </table>
</div>
@endsection
