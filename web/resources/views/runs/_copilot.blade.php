@php
    $canRun = auth()->user()->can('run-scenario');
    $canApprove = auth()->user()->can('approve-schedule');
@endphp
<div class="card" id="copilot"
     data-url="{{ route('copilot.chat') }}" data-run="{{ $run->id }}" data-runs-url="{{ route('runs.store') }}"
     data-approve-url="{{ url('/runs/__RUN__/versions/__VERSION__/approve') }}" data-token="{{ csrf_token() }}"
     data-can-run="{{ $canRun ? 1 : 0 }}" data-can-approve="{{ $canApprove ? 1 : 0 }}">
    <h3>Copilot</h3>
    <p class="muted">Copilot hanya menjawab dari hasil alat dan hanya mengusulkan. Keputusan ada pada pengguna; keputusan mutu (release batch) dan ambang tidak dapat diubah lewat chat. Data DEMO.</p>
    <div id="cp-log" aria-live="polite" style="max-height:320px;overflow:auto;margin-bottom:8px"></div>
    <form id="cp-form" style="display:flex;gap:8px">
        <input id="cp-input" maxlength="1000" autocomplete="off" required style="margin:0"
               placeholder="Contoh: bandingkan run ini dengan run lain / jelaskan truk RT-001">
        <button id="cp-send" type="submit">Kirim</button>
    </form>
    <p id="cp-note" class="muted" style="font-size:12px"></p>
</div>

<script>
(() => {
    const root = document.getElementById('copilot');
    const log = document.getElementById('cp-log');
    const form = document.getElementById('cp-form');
    const input = document.getElementById('cp-input');
    const send = document.getElementById('cp-send');
    const note = document.getElementById('cp-note');
    const history = [];
    const canRun = root.dataset.canRun === '1';
    const canApprove = root.dataset.canApprove === '1';

    const el = (tag, text, css) => {
        const e = document.createElement(tag);
        if (text !== undefined) e.textContent = text;
        if (css) e.style.cssText = css;
        return e;
    };
    const bubble = (who, text) => {
        const box = el('div', '', 'margin:6px 0;padding:8px;border-radius:6px;white-space:pre-wrap;' +
            (who === 'user' ? 'background:#e8f1f8' : 'background:#f4f6f8'));
        box.append(el('b', who === 'user' ? 'Anda: ' : 'Copilot: '), document.createTextNode(text));
        log.append(box);
        log.scrollTop = log.scrollHeight;
        return box;
    };

    // Approval Modal (pagar 2): PPIC menyetujui dengan alasan.
    const dialog = document.getElementById('approval');
    const openApproval = (runId, version, rationale) => {
        if (!dialog || !canApprove) return;
        document.getElementById('approval-form').action =
            root.dataset.approveUrl.replace('__RUN__', runId).replace('__VERSION__', version);
        document.getElementById('approval-title').textContent = `Setujui jadwal v${version} (run #${runId})`;
        document.getElementById('approval-rationale').textContent = rationale ? `Usulan Copilot: ${rationale}` : '';
        document.getElementById('approval-reason').value = '';
        dialog.showModal();
    };
    document.getElementById('approval-cancel')?.addEventListener('click', () => dialog.close());
    document.querySelectorAll('[data-approve]').forEach((b) =>
        b.addEventListener('click', () => openApproval(b.dataset.run, b.dataset.version, '')));

    const postRun = (params) => {
        const f = el('form');
        f.method = 'POST';
        f.action = root.dataset.runsUrl;
        const fields = {_token: root.dataset.token, via: 'copilot', ...params};
        for (const [k, v] of Object.entries(fields)) {
            const i = el('input');
            i.type = 'hidden'; i.name = k; i.value = String(v);
            f.append(i);
        }
        document.body.append(f);
        f.submit();
    };

    const proposalCard = (p) => {
        const card = el('div', '', 'margin:6px 0;padding:8px;border:1px dashed #0b3d5c;border-radius:6px');
        if (p.kind === 'run') {
            card.append(el('b', 'Usulan run (belum dijalankan)'));
            const list = el('ul', '', 'margin:4px 0;padding-left:18px');
            for (const [k, v] of Object.entries(p.params)) list.append(el('li', `${k}: ${v}`));
            card.append(list);
            const diff = Object.entries(p.diff || {});
            if (diff.length) {
                card.append(el('div', 'Perbedaan dari run ini: ' + diff.map(([k, d]) => `${k} ${d.dari} -> ${d.menjadi}`).join('; '), 'font-size:12px'));
            }
            if (canRun) {
                const b = el('button', 'Setujui dan jalankan', 'margin-top:6px');
                b.type = 'button';
                b.addEventListener('click', () => postRun(p.params));
                card.append(b);
            }
        } else if (p.kind === 'approve_plan') {
            card.append(el('b', `Usulan aktivasi jadwal v${p.version} (run #${p.run_id})`), el('div', p.rationale, 'font-size:12px'));
            if (canApprove) {
                const b = el('button', 'Tinjau dan setujui', 'margin-top:6px');
                b.type = 'button';
                b.addEventListener('click', () => openApproval(p.run_id, p.version, p.rationale));
                card.append(b);
            }
        }
        return card;
    };

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const message = input.value.trim();
        if (!message) return;
        bubble('user', message);
        input.value = '';
        send.disabled = true;
        note.textContent = 'Menunggu Copilot...';
        try {
            const res = await fetch(root.dataset.url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-TOKEN': root.dataset.token},
                body: JSON.stringify({message, run_id: Number(root.dataset.run), history: history.slice(-10)}),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const r = await res.json();
            const box = bubble('assistant', r.text);
            if (r.status !== 'ok') box.style.background = '#fee2e2';
            if (r.status === 'ok') {
                history.push({role: 'user', content: message}, {role: 'assistant', content: r.text});
            }
            if (r.sources.length) {
                const src = el('div', 'Lihat Data: ', 'font-size:12px;margin-top:4px');
                for (const s of r.sources) {
                    const a = el('a', s.label, 'margin-right:10px');
                    a.href = s.url;
                    src.append(a);
                }
                box.append(src);
            }
            for (const p of r.proposals) box.append(proposalCard(p));
            note.textContent = '';
        } catch (e) {
            bubble('assistant', 'Copilot tidak dapat dihubungi. Gunakan Panel Skenario di Dashboard.').style.background = '#fee2e2';
            note.textContent = '';
        } finally {
            send.disabled = false;
            input.focus();
        }
    });
})();
</script>
