@extends('layouts.app')
@section('title', 'Operasi pabrik | LactaTwin')
@section('bare', '1')

@push('head')
<meta name="csrf-token" content="{{ csrf_token() }}">
@vite('resources/js/operation.js')
@endpush

@php
    $op = app(\App\Services\OperationService::class)->state();
    $waiting = $op['exists'] && $op['target_status'] === 'running';
    $canStart = auth()->user()->can('manage-campaign');
@endphp

@section('content')
<div id="tw" class="tw tw-dash" data-theme="light" data-state-url="{{ route('operation.state') }}" data-advance-url="{{ route('operation.advance') }}" data-can-start="{{ $canStart ? '1' : '0' }}" data-waiting="{{ $waiting ? '1' : '0' }}">
    @include('runs._topbar', ['active' => $active ?? 'dashboard'])
    <main class="dash">
        <section class="tw-card" aria-labelledby="h-none">
            <h1 id="h-none">{{ $waiting ? 'Menyiapkan hari operasi' : 'Operasi pabrik belum dimulai' }}</h1>
            <p class="muted">{{ $canStart ? 'Mulai dari Hari 1, 3 November 2026. Setiap hari tersimpan dan bisa diputar ulang.' : 'Menunggu PPIC memulai operasi.' }}</p>
            @if ($canStart && ! $waiting)
                <button id="op-start" class="tw-btn primary" type="button">Mulai Hari {{ $op['target_day'] }}</button>
            @endif
            <p id="op-msg" class="muted" role="status"></p>
        </section>
    </main>
</div>
@endsection
