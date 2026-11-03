@unless ($plain ?? false)
@include('runs._approval')
@endunless
@php
    $liveRun = isset($run) && $run && $run->modeBadge()['key'] === 'live';
    $asMode = ! isset($campaign) && $liveRun ? 'LIVE' : 'SIMULASI';
@endphp
<aside id="cp-drawer" class="{{ ($plain ?? false) ? 'as-drawer as-plain' : 'tw-drawer as-drawer' }}" aria-label="Asisten AI" hidden
    data-user-id="{{ auth()->id() }}" data-can-approve="{{ auth()->user()->can('approve-proposal') ? 1 : 0 }}"
    data-turn-url="{{ route('agent.turn') }}" data-proposals-url="{{ route('agent.proposals.index') }}"
    @isset($run) data-run-id="{{ $run->id }}" @endisset
    @isset($campaign) data-campaign-id="{{ $campaign->id }}" data-reload-on-approve="1" @endisset>
    <div class="tw-drawer-head">
        <h2>Asisten AI</h2>
        <button id="cp-new" class="as-new as-secondary" type="button">Percakapan baru</button>
        <button id="cp-close" class="tw-ico" type="button" aria-label="Tutup asisten" data-icon="x"></button>
    </div>
    <p id="cp-label" class="as-label" data-mode="{{ $asMode }}" hidden></p>
    <p class="as-meta">Asisten hanya membaca data operasi dan mengusulkan. Keputusan tetap di PPIC.</p>
    @isset($campaign)
    <section aria-labelledby="cp-ptitle">
        <h3 id="cp-ptitle">Usulan operasi</h3>
        <p id="cp-empty" class="as-meta">Belum ada usulan. Minta asisten mengusulkan jadwal maintenance tangki.</p>
        <div id="cp-plist" class="as-log"></div>
    </section>
    @else
    <div id="cp-empty" hidden></div><div id="cp-plist" hidden></div>
    @endisset
    <div id="cp-log" class="as-log" role="log" aria-live="polite"></div>
    <div id="cp-chips" class="as-chips" aria-label="Contoh pertanyaan"></div>
    <form id="cp-form" class="as-form">
        <label for="cp-input" class="sr-only">Pertanyaan untuk asisten</label>
        <textarea id="cp-input" rows="2" placeholder="Tanyakan hasil run atau minta usulan..." required></textarea>
        <button id="cp-send" type="submit">Kirim</button>
    </form>
</aside>
