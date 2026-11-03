// Drawer Asisten AI: chat dan kartu usulan. Semua teks dari server dipasang lewat textContent (tidak ada innerHTML).
import '../../../css/assistant.css';
import { h } from './dom.js';
import { hydrateIcons } from './icons.js';
import {
    MAX_MESSAGE, buildTurn, canDecide, canSubmit, changeRows, describeWindow, httpError, pushHistory, reasonError, replyNote, restoreChat,
    revealStep, revisePrompt, serializeChat, statusLabel, storageKey, suggestions,
} from './assistant-model.js';

const STATUS_TONE = { draft: 'brand', pending: 'warn', approved: 'ok', rejected: 'bad', expired: 'mute', superseded: 'mute' };

export function initAssistant(root) {
    hydrateIcons(root);
    const drawer = root.querySelector('#cp-drawer');
    const openBtn = root.querySelector('#cp-open');
    if (!drawer || !openBtn) return;

    const d = drawer.dataset;
    const cfg = {
        runId: d.runId || '', campaignId: d.campaignId || '', userId: Number(d.userId), canApprove: d.canApprove === '1',
        turnUrl: d.turnUrl, proposalsUrl: d.proposalsUrl, reloadOnApprove: d.reloadOnApprove === '1',
    };
    const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content ?? '';
    const $ = (sel) => drawer.querySelector(sel);
    const log = $('#cp-log');
    const form = $('#cp-form');
    const input = $('#cp-input');
    const send = $('#cp-send');
    const plist = $('#cp-plist');
    const chips = $('#cp-chips');
    let conversationId = null;
    let history = [];
    let messages = [];
    let loaded = false;
    let busy = false;
    let skipReveal = false;
    const cards = new Map();
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const key = storageKey(cfg);

    // Percakapan hanya bertahan selama tab terbuka (sessionStorage), per pengguna dan konteks.
    function persist() {
        try {
            sessionStorage.setItem(key, serializeChat({ conversationId, history, messages }));
        } catch { /* penyimpanan penuh atau dinonaktifkan: percakapan tetap berjalan */ }
    }

    function renderChips() {
        chips.replaceChildren();
        if (messages.length) return;
        for (const s of suggestions(cfg)) {
            chips.append(h('button', { type: 'button', class: 'as-suggest as-secondary', onclick: () => {
                if (busy) return;
                input.value = s;
                form.requestSubmit();
            } }, s));
        }
    }

    function resetChat() {
        conversationId = null;
        history = [];
        messages = [];
        log.replaceChildren();
        try { sessionStorage.removeItem(key); } catch { /* abaikan */ }
        renderChips();
        input.focus({ preventScroll: true });
    }

    async function call(url, init = {}) {
        const res = await fetch(url, {
            credentials: 'same-origin',
            ...init,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf() },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(httpError(res.status, body));
        return body;
    }

    function setOpen(open) {
        drawer.hidden = !open;
        openBtn.setAttribute('aria-expanded', String(open));
        if (open) {
            input.focus({ preventScroll: true });
            if (cfg.campaignId && !loaded) {
                loaded = true;
                loadProposals();
            }
        } else openBtn.focus({ preventScroll: true });
    }
    openBtn.addEventListener('click', () => setOpen(drawer.hidden));
    $('#cp-close').addEventListener('click', () => setOpen(false));
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !drawer.hidden && !document.querySelector('dialog[open]')) {
            e.stopPropagation();
            setOpen(false);
        }
    });

    /** Pengetikan bertahap SETELAH jawaban lolos validasi server; klik pada teks melewati animasi. */
    async function reveal(el, text) {
        if (calm || text.length < 4) {
            el.textContent = text;
            return;
        }
        skipReveal = false;
        const step = revealStep(text.length);
        log.setAttribute('aria-busy', 'true');
        for (let i = step; i < text.length && !skipReveal; i += step) {
            el.textContent = text.slice(0, i);
            log.scrollTop = log.scrollHeight;
            await new Promise((r) => setTimeout(r, 18));
        }
        el.textContent = text;
        log.removeAttribute('aria-busy');
    }
    log.addEventListener('click', () => { skipReveal = true; });

    function addMessage(role, text, meta) {
        const msg = h('div', { class: `as-msg as-${role}` },
            h('div', { class: 'as-who' }, role === 'user' ? 'Anda' : 'Asisten'),
            h('div', { class: 'as-text' }, text));
        if (meta) msg.append(h('div', { class: 'as-meta' }, meta));
        log.append(msg);
        log.scrollTop = log.scrollHeight;
        return msg;
    }

    const sourcesText = (sources) => {
        const parts = (sources ?? []).filter((s) => s.tool).map((s) => (s.run_id ? `${s.tool} run #${s.run_id}` : s.tool));
        return parts.length ? `Sumber: ${[...new Set(parts)].join(', ')}` : '';
    };

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || busy) return;
        busy = true;
        send.disabled = true;
        input.value = '';
        chips.replaceChildren();
        addMessage('user', text);
        messages.push({ role: 'user', text });
        const wait = addMessage('assistant', 'Menyusun jawaban dari data...');
        wait.setAttribute('aria-busy', 'true');
        let shown = null;
        try {
            const reply = await call(cfg.turnUrl, {
                method: 'POST',
                body: JSON.stringify(buildTurn({ message: text, conversationId, runId: cfg.runId, campaignId: cfg.campaignId, history })),
            });
            conversationId = reply.conversation_id ?? conversationId;
            if (reply.label) $('#cp-label').textContent = reply.label;
            const ok = reply.status === 'ok';
            const body = ok ? reply.text : replyNote(reply);
            const src = ok ? sourcesText(reply.sources) : '';
            wait.classList.toggle('as-error', !ok);
            wait.removeAttribute('aria-busy');
            await reveal(wait.querySelector('.as-text'), body);
            if (src) wait.append(h('div', { class: 'as-meta' }, src));
            shown = { role: 'assistant', text: body, meta: src, error: !ok };
            history = pushHistory(history, text, reply);
            const drafts = reply.proposals ?? [];
            drafts.forEach(renderProposal);
            drafts.filter((p) => p.supersedes && cards.has(p.supersedes)).forEach((p) => refreshCard(p.supersedes));
        } catch (err) {
            wait.querySelector('.as-text').textContent = err.message;
            wait.classList.add('as-error');
            shown = { role: 'assistant', text: err.message, error: true };
        } finally {
            wait.removeAttribute('aria-busy');
            log.removeAttribute('aria-busy');
            if (shown) messages.push(shown);
            persist();
            busy = false;
            send.disabled = false;
            input.focus({ preventScroll: true });
        }
    });
    $('#cp-new').addEventListener('click', () => { if (!busy) resetChat(); });

    const saved = (() => {
        try { return restoreChat(sessionStorage.getItem(key)); } catch { return null; }
    })();
    if (saved) {
        ({ conversationId, history, messages } = saved);
        messages.forEach((m) => {
            const el = addMessage(m.role, m.text, m.meta);
            if (m.error) el.classList.add('as-error');
        });
    }
    renderChips();
    input.maxLength = MAX_MESSAGE;
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    // --- usulan ---------------------------------------------------------------------------------

    async function loadProposals() {
        try {
            const body = await call(`${cfg.proposalsUrl}?campaign_id=${encodeURIComponent(cfg.campaignId)}`);
            plist.replaceChildren();
            cards.clear();
            [...body.proposals].reverse().forEach(renderProposal);
            $('#cp-empty').hidden = body.proposals.length > 0;
        } catch (err) {
            $('#cp-empty').hidden = false;
            $('#cp-empty').textContent = err.message;
        }
    }

    /** Perbarui kartu lama (mis. menjadi "Digantikan versi baru") setelah revisi lewat chat. */
    async function refreshCard(id) {
        try {
            renderProposal((await call(`${cfg.proposalsUrl}/${id}`)).proposal);
        } catch { /* kartu tetap; status benar akan tampil saat daftar dimuat ulang */ }
    }

    async function act(p, action, payload, card) {
        const err = card.querySelector('.as-err');
        err.textContent = '';
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
            const { proposal } = await call(`${cfg.proposalsUrl}/${p.id}/${action}`, { method: 'POST', body: JSON.stringify(payload ?? {}) });
            renderProposal(proposal);
            if (action === 'approve' && cfg.reloadOnApprove) setTimeout(() => window.location.reload(), 900);
        } catch (e) {
            // status bisa berubah di server (mis. kedaluwarsa); tampilkan keadaan terbaru bersama pesannya
            try {
                renderProposal((await call(`${cfg.proposalsUrl}/${p.id}`)).proposal, e.message);
            } catch {
                err.textContent = e.message;
                card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            }
        }
    }

    function renderProposal(p, error = '') {
        $('#cp-empty').hidden = true;
        const rows = changeRows(p.whatif);
        const card = h('article', { class: 'as-card', dataset: { status: p.status }, 'aria-label': `Usulan ${describeWindow(p.payload)}` },
            h('div', { class: 'as-card-head' },
                h('strong', {}, `Maintenance ${describeWindow(p.payload)}`),
                h('span', { class: 'as-chip', dataset: { tone: STATUS_TONE[p.status] ?? 'mute' } }, statusLabel(p.status))),
            h('p', { class: 'as-meta' }, `Hari ${p.day_no}, versi ${p.version}. ${p.label}`),
            h('p', {}, p.rationale),
            rows.length
                ? h('ul', { class: 'as-changes', 'aria-label': 'Dampak what-if terhadap hari tanpa maintenance ini' },
                    rows.map((r) => h('li', { dataset: { tone: r.tone } }, `${r.label}: ${r.text}, `, h('b', {}, r.verdict))))
                : h('p', { class: 'as-meta' }, 'What-if tidak menunjukkan perubahan KPI.'));
        if (p.decision_reason) card.append(h('p', { class: 'as-meta' }, `Alasan keputusan: ${p.decision_reason}`));
        card.append(h('p', { class: 'as-err err', role: 'alert' }, error));

        if (canSubmit(p, cfg.userId, cfg.canApprove)) {
            card.append(h('div', { class: 'as-actions' },
                h('button', { type: 'button', onclick: () => act(p, 'submit', null, card) }, 'Ajukan ke PPIC')));
        }
        if (canDecide(p, cfg.canApprove)) {
            const reason = h('textarea', { id: `r-${p.id}`, rows: 2, maxlength: 500, required: true });
            const decide = (action) => {
                const msg = reasonError(reason.value);
                if (msg) {
                    card.querySelector('.as-err').textContent = msg;
                    reason.focus();
                    return;
                }
                act(p, action, { reason: reason.value.trim() }, card);
            };
            card.append(
                h('label', { for: `r-${p.id}` }, 'Alasan keputusan (wajib, min. 5 karakter)'),
                reason,
                h('p', { class: 'as-meta' }, 'Menyetujui menambah jadwal maintenance pada hari ini dan dicatat ke audit log. Aturan keras tetap diperiksa ulang.'),
                h('div', { class: 'as-actions' },
                    h('button', { type: 'button', onclick: () => decide('approve') }, 'Setujui'),
                    h('button', { type: 'button', class: 'as-secondary', onclick: () => decide('reject') }, 'Tolak')));
        }

        if (['draft', 'pending'].includes(p.status) && p.created_by === cfg.userId && cfg.campaignId) {
            card.append(h('div', { class: 'as-actions' },
                h('button', { type: 'button', class: 'as-secondary', onclick: () => {
                    input.value = revisePrompt(p);
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                } }, 'Tanya atau revisi lewat chat')));
        }

        const old = cards.get(p.id);
        if (old) old.replaceWith(card);
        else plist.prepend(card);
        cards.set(p.id, card);
    }
}
