@extends('layouts.app')
@section('title', 'Belum ada run | LactOS')
@section('bare', '1')

@push('head')
@vite('resources/js/home.js')
@endpush

@section('content')
<div id="tw" class="tw tw-dash" data-theme="light">
    @include('runs._topbar', ['active' => $active ?? 'dashboard'])
    <main class="dash">
        <section class="tw-card" aria-labelledby="h-none">
            <h1 id="h-none">Belum ada run simulasi</h1>
            <p class="muted">Dashboard, Digital Twin, dan Maps menampilkan hasil sebuah run. Mulai satu dari daftar run.</p>
            <a class="tw-btn primary" href="{{ route('runs.index') }}">Buka daftar run</a>
        </section>
    </main>
</div>
@endsection
