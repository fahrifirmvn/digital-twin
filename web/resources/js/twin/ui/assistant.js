// Drawer Asisten AI: chat dan kartu usulan. Semua teks dari server dipasang lewat textContent (tidak ada innerHTML).
import '../../../css/assistant.css';
import { h } from './dom.js';
import { hydrateIcons } from './icons.js';
import { parseAssistantText, splitEntityRefs } from './assistant-format.js';
import {
    MAX_MESSAGE, allowReason, buildTurn, canDecide, canSubmit, changeRows, describeContext, describeWindow, dueNotice,
    followUpSuggestions, httpError, modelNote, pushHistory, reasonError, replyNote, restoreChat,
    revealStep, revisePrompt, serializeChat, statusLabel, storageKey, suggestions, toolSummaryBadges,
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
        live: d.live === '1', opStateUrl: d.opStateUrl || '',
    };
    const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content ?? '';
    const $ = (sel) => drawer.querySelector(sel);
    const log = $('#cp-log');
    const form = $('#cp-form');
    const input = $('#cp-input');
    const send = $('#cp-send');
    const plist = $('#cp-plist');
    const chips = $('#cp-chips');
    const ctxBox = $('#cp-ctx');
    let conversationId = null;
    let history = [];
    let messages = [];
    let loaded = false;
    let busy = false;
    let skipReveal = false;
    let controller = null;
    let uiContext = { selected: null, minute: null, view: null };
    const cards = new Map();
    /** Gulir otomatis hanya bila pengguna memang sedang di dasar log (tidak melompat saat membaca ke atas). */
    const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const toBottom = () => { log.scrollTop = log.scrollHeight; };
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const key = storageKey(cfg);

    // Percakapan tersimpan di peramban (localStorage), per pengguna dan konteks, dan dibagikan antar tab.
    function persist() {
        try {
            localStorage.setItem(key, serializeChat({ conversationId, history, messages }));
        } catch { /* penyimpanan penuh atau dinonaktifkan: percakapan tetap berjalan */ }
    }

    function renderContextPill() {
        if (!ctxBox) return;
        const label = describeContext(uiContext);
        if (!label) {
            ctxBox.hidden = true;
            ctxBox.replaceChildren();
            return;
        }
        ctxBox.hidden = false;
        ctxBox.replaceChildren(
            h('span', { class: 'as-ctx-label' }, label),
            h('button', { type: 'button', class: 'as-ctx-clear as-secondary', 'aria-label': 'Lepas fokus aset', onclick: () => {
                uiContext = { ...uiContext, selected: null };
                renderContextPill();
            } }, '×'),
        );
    }

    function renderChipList(items) {
        chips.replaceChildren();
        for (const s of items) {
            chips.append(h('button', { type: 'button', class: 'as-suggest as-secondary', onclick: () => {
                if (busy) return;
                input.value = s;
                form.requestSubmit();
            } }, s));
        }
    }

    function renderChips(lastTools = null) {
        if (!messages.length) {
            renderChipList(suggestions(cfg));
        } else if (lastTools) {
            renderChipList(followUpSuggestions(lastTools, { ...cfg, selected: uiContext.selected }));
        } else {
            chips.replaceChildren();
        }
    }

    function resetChat() {
        conversationId = null;
        history = [];
        messages = [];
        log.replaceChildren();
        try { localStorage.removeItem(key); } catch { /* abaikan */ }
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
        drawer.dataset.open = open ? '1' : '0';
        openBtn.setAttribute('aria-expanded', String(open));
        if (open) {
            input.focus({ preventScroll: true });
            if (cfg.campaignId && !loaded) {
                loaded = true;
                loadProposals();
            }
            if (cfg.live) showNotice();
        } else openBtn.focus({ preventScroll: true });
    }
    openBtn.addEventListener('click', () => setOpen(drawer.hidden));
    $('#cp-close').addEventListener('click', () => setOpen(false));
    // Zona Proses atau Sheet 3D menyiapkan pertanyaan: kolom diisi dan konteks disinkronkan.
    document.addEventListener('assistant:ask', (e) => {
        const text = String(e.detail?.text ?? '').slice(0, input.maxLength > 0 ? input.maxLength : 600);
        if (e.detail?.code) {
            uiContext = { ...uiContext, selected: String(e.detail.code) };
            renderContextPill();
        }
        if (!text || busy) return;
        setOpen(true);
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    document.addEventListener('twin:context', (e) => {
        const d = e.detail ?? {};
        if ('selected' in d) uiContext.selected = d.selected || null;
        if ('minute' in d) uiContext.minute = d.minute;
        if ('view' in d) uiContext.view = d.view;
        renderContextPill();
    });
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
            const follow = atBottom();
            el.textContent = text.slice(0, i);
            if (follow) toBottom();
            await new Promise((r) => setTimeout(r, 18));
        }
        el.textContent = text;
        log.removeAttribute('aria-busy');
    }
    log.addEventListener('click', () => { skipReveal = true; });

    function addMessage(role, text, meta, tools = null) {
        const follow = role === 'user' || atBottom();
        const msg = h('div', { class: `as-msg as-${role}` },
            h('div', { class: 'as-who' }, role === 'user' ? 'Anda' : 'Asisten'));
        if (role === 'assistant' && tools?.length) {
            const badges = toolSummaryBadges(tools);
            if (badges.length) {
                msg.append(h('div', { class: 'as-tools', 'aria-label': 'Alat yang dijalankan' },
                    badges.map((b) => h('span', { class: 'as-tool-badge', dataset: { ok: b.ok ? '1' : '0' } }, b.label))));
            }
        }
        const body = h('div', { class: 'as-text' });
        if (role === 'assistant') renderAssistantText(body, text);
        else body.textContent = text;
        msg.append(body);
        if (meta) msg.append(h('div', { class: 'as-meta' }, meta));
        log.append(msg);
        if (follow) toBottom();
        return msg;
    }

    function renderEntityNode(code, label) {
        return h('button', {
            type: 'button',
            class: 'as-entity',
            title: `Fokus ke ${code} di tampilan pabrik`,
            onclick: () => document.dispatchEvent(new CustomEvent('twin:select', { detail: { code } })),
        }, label);
    }

    function renderTextWithEntities(value) {
        return splitEntityRefs(value).map((tok) => (
            tok.type === 'entity' ? renderEntityNode(tok.code, tok.text) : document.createTextNode(tok.text)
        ));
    }

    function renderAssistantText(el, text) {
        const inline = (parts) => parts.flatMap(({ type, text: value }) => {
            if (type === 'text') return renderTextWithEntities(value);
            if (type === 'code') {
                const refs = splitEntityRefs(value);
                if (refs.length === 1 && refs[0].type === 'entity') return [renderEntityNode(refs[0].code, value)];
                return [h('code', {}, value)];
            }
            return [h(type === 'strong' ? 'strong' : 'em', {}, renderTextWithEntities(value))];
        });
        el.replaceChildren(...parseAssistantText(text).map((block) => {
            if (block.type === 'ul' || block.type === 'ol') {
                return h(block.type, {}, block.items.map((item) => h('li', {}, inline(item))));
            }
            const tag = block.type === 'heading' ? `h${block.level + 2}` : 'p';
            return h(tag, {}, inline(block.content));
        }));
    }

    function thinkingMessage() {
        return h('span', { class: 'as-thinking', role: 'status' },
            h('span', { class: 'as-thinking-label' }, uiContext.selected ? `Memeriksa data (${uiContext.selected})` : 'Sedang memeriksa data pabrik'),
            h('span', { class: 'as-thinking-dots', 'aria-hidden': 'true' },
                h('i'), h('i'), h('i')));
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
        controller = new AbortController();
        send.textContent = 'Berhenti';
        send.dataset.stop = '1';
        input.value = '';
        chips.replaceChildren();
        addMessage('user', text);
        messages.push({ role: 'user', text });
        const wait = addMessage('assistant', '');
        wait.querySelector('.as-text').replaceChildren(thinkingMessage());
        wait.setAttribute('aria-busy', 'true');
        let shown = null;
        let lastTools = null;
        try {
            const reply = await call(cfg.turnUrl, {
                method: 'POST',
                signal: controller.signal,
                body: JSON.stringify(buildTurn({ message: text, conversationId, runId: cfg.runId, campaignId: cfg.campaignId, history, uiContext })),
            });
            conversationId = reply.conversation_id ?? conversationId;
            if (reply.label) $('#cp-label').textContent = [reply.label, modelNote(reply)].filter(Boolean).join(' | ');
            const ok = reply.status === 'ok';
            const body = ok ? reply.text : replyNote(reply);
            const src = ok ? sourcesText(reply.sources) : '';
            wait.classList.toggle('as-error', !ok);
            wait.removeAttribute('aria-busy');
            const badges = ok ? toolSummaryBadges(reply.tools) : [];
            if (badges.length) {
                wait.querySelector('.as-who').after(h('div', { class: 'as-tools', 'aria-label': 'Alat yang dijalankan' },
                    badges.map((b) => h('span', { class: 'as-tool-badge', dataset: { ok: b.ok ? '1' : '0' } }, b.label))));
            }
            const answer = wait.querySelector('.as-text');
            await reveal(answer, body);
            renderAssistantText(answer, body);
            if (src) wait.append(h('div', { class: 'as-meta' }, src));
            shown = { role: 'assistant', text: body, meta: src, error: !ok };
            if (ok) lastTools = reply.tools ?? [];
            history = pushHistory(history, text, reply);
            const drafts = reply.proposals ?? [];
            drafts.forEach(renderProposal);
            (reply.exports ?? []).forEach(renderExport);
            drafts.filter((p) => p.supersedes && cards.has(p.supersedes)).forEach((p) => refreshCard(p.supersedes));
        } catch (err) {
            const stopped = err.name === 'AbortError';
            const msg = stopped ? 'Dihentikan. Pertanyaan Anda dikembalikan ke kolom input.' : err.message;
            wait.querySelector('.as-text').textContent = msg;
            wait.classList.add('as-error');
            shown = { role: 'assistant', text: msg, error: true };
            // pertanyaan tidak hilang bila gagal atau dihentikan
            if (!input.value) input.value = text;
        } finally {
            wait.removeAttribute('aria-busy');
            log.removeAttribute('aria-busy');
            if (shown) messages.push(shown);
            persist();
            busy = false;
            controller = null;
            send.textContent = 'Kirim';
            delete send.dataset.stop;
            if (lastTools !== null) renderChips(lastTools);
            input.focus({ preventScroll: true });
        }
    });
    send.addEventListener('click', (e) => {
        if (!busy) return;
        e.preventDefault();
        controller?.abort();
    });
    $('#cp-new').addEventListener('click', () => { if (!busy) resetChat(); });
    // tab lain menyimpan percakapan baru: ikuti hanya bila tab ini sedang tidak mengirim
    window.addEventListener('storage', (e) => {
        if (e.key !== key || busy) return;
        const next = restoreChat(e.newValue);
        log.replaceChildren();
        cards.clear();
        ({ conversationId, history, messages } = next ?? { conversationId: null, history: [], messages: [] });
        messages.forEach((m) => {
            const el = addMessage(m.role, m.text, m.meta);
            if (m.error) el.classList.add('as-error');
        });
        renderChips();
        if (cfg.live && cfg.campaignId) loadProposals();
    });

    const saved = (() => {
        try { return restoreChat(localStorage.getItem(key)); } catch { return null; }
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
            // Operasi: hanya usulan terbuka milik pengguna yang ditampilkan lagi di percakapan.
            const list = cfg.live ? body.proposals.filter((p) => ['draft', 'pending'].includes(p.status) && p.created_by === cfg.userId) : body.proposals;
            [...list].reverse().forEach(renderProposal);
            $('#cp-empty').hidden = list.length > 0;
        } catch (err) {
            $('#cp-empty').hidden = false;
            $('#cp-empty').textContent = err.message;
        }
    }

    /** Pemberitahuan tangki yang perlu servis; asisten baru bekerja setelah tombolnya ditekan (izin pengguna). */
    async function showNotice() {
        drawer.querySelector('.as-notice')?.remove();
        if (!cfg.opStateUrl || !cfg.canApprove) return;
        let notice;
        try {
            notice = dueNotice(await call(cfg.opStateUrl));
        } catch { return; }
        if (!notice || drawer.querySelector('.as-notice')) return;
        log.before(h('div', { class: 'as-notice', role: 'status' },
            h('strong', {}, 'Perlu perhatian'),
            h('p', {}, notice.text),
            h('button', { type: 'button', onclick: (e) => {
                if (busy) return;
                e.currentTarget.closest('.as-notice').remove();
                input.value = notice.prompt;
                form.requestSubmit();
            } }, 'Susun usulan maintenance')));
    }

    /** Perbarui kartu lama (mis. menjadi "Digantikan versi baru") setelah revisi lewat chat. */
    async function refreshCard(id) {
        try {
            renderProposal((await call(`${cfg.proposalsUrl}/${id}`)).proposal);
        } catch { /* kartu tetap; status benar akan tampil saat daftar dimuat ulang */ }
    }

    function renderExport(item) {
        const runId = Number(item.run_id);
        const format = String(item.format ?? '');
        const url = new URL(String(item.url ?? ''), location.origin);
        if (!Number.isSafeInteger(runId) || runId < 1 || !['csv', 'pdf', 'docx'].includes(format)
            || url.origin !== location.origin || !url.pathname.endsWith(`/runs/${runId}/report/${format}`)) return;
        const label = format.toUpperCase();
        const card = h('article', { class: 'as-card as-export', 'aria-label': `Persetujuan unduh laporan ${label} run ${runId}` },
            h('div', { class: 'as-card-head' }, h('strong', {}, `Laporan run #${runId}`), h('span', { class: 'as-chip', dataset: { tone: 'brand' } }, label)),
            h('p', {}, `Unduhan ${label} belum dimulai. Tekan tombol untuk menyetujui dan mengunduh; tindakan ini dicatat di audit log.`),
            h('div', { class: 'as-actions' }, h('button', { type: 'button', onclick: () => window.location.assign(url.href) }, `Setujui dan unduh ${label}`)));
        const follow = atBottom();
        log.append(card);
        if (follow) toBottom();
    }

    async function act(p, steps, card) {
        const err = card.querySelector('.as-err');
        err.textContent = '';
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
            let last = null;
            for (const [action, payload] of steps) {
                last = (await call(`${cfg.proposalsUrl}/${p.id}/${action}`, { method: 'POST', body: JSON.stringify(payload ?? {}) })).proposal;
            }
            renderProposal(last);
            if (last.status === 'approved' && cfg.reloadOnApprove) setTimeout(() => window.location.reload(), 900);
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
        const assetCode = p.payload?.asset;
        const card = h('article', { class: 'as-card', dataset: { status: p.status }, 'aria-label': `Usulan ${describeWindow(p.payload)}` },
            h('div', { class: 'as-card-head' },
                h('strong', {}, `Maintenance `, assetCode ? renderEntityNode(assetCode, assetCode) : '', assetCode ? `, ${describeWindow(p.payload).slice(assetCode.length + 2)}` : describeWindow(p.payload)),
                h('span', { class: 'as-chip', dataset: { tone: STATUS_TONE[p.status] ?? 'mute' } }, statusLabel(p.status))),
            h('p', { class: 'as-meta' }, `Hari ${p.day_no}, versi ${p.version}. ${p.label}`),
            h('p', {}, renderTextWithEntities(p.rationale)),
            rows.length
                ? h('ul', { class: 'as-changes', 'aria-label': 'Dampak what-if terhadap hari tanpa maintenance ini' },
                    rows.map((r) => h('li', { dataset: { tone: r.tone } },
                        h('div', { class: 'as-change-line' }, `${r.label}: ${r.text}, `, h('b', {}, r.verdict)),
                        r.pct > 0 ? h('span', { class: 'as-delta-track', 'aria-hidden': 'true' },
                            h('i', { class: 'as-delta-fill', style: `width:${r.pct}%` })) : null)))
                : h('p', { class: 'as-meta' }, 'What-if tidak menunjukkan perubahan KPI.'));
        if (p.decision_reason) card.append(h('p', { class: 'as-meta' }, `Alasan keputusan: ${p.decision_reason}`));
        if (cfg.live && p.status === 'approved') {
            card.append(h('p', { class: 'as-meta' }, `Diterapkan: berlaku mulai Hari ${p.day_no}. Hari yang sedang ditonton tidak berubah; engine menghitung ulang Hari ${p.day_no}.`));
        }
        card.append(h('p', { class: 'as-err err', role: 'alert' }, error));

        if (cfg.live && cfg.canApprove && ['draft', 'pending'].includes(p.status)) {
            // Operasi: satu izin dari pengguna berwenang mengajukan dan menerapkan; asisten tidak menerapkan apa pun sendiri.
            const note = h('input', { id: `n-${p.id}`, type: 'text', maxlength: 500, placeholder: 'Catatan (opsional)' });
            const steps = (action) => [...(p.status === 'draft' ? [['submit', null]] : []), [action, { reason: allowReason(note.value) }]];
            card.append(
                h('label', { class: 'as-meta', for: `n-${p.id}` }, 'Catatan untuk audit log'),
                note,
                h('p', { class: 'as-meta' }, `Izinkan menjadwalkan maintenance ini mulai Hari ${p.day_no}. Aturan keras diperiksa ulang dan keputusan dicatat ke audit log.`),
                h('div', { class: 'as-actions' },
                    h('button', { type: 'button', onclick: () => act(p, steps('approve'), card) }, 'Izinkan dan terapkan'),
                    h('button', { type: 'button', class: 'as-secondary', onclick: () => act(p, p.status === 'draft' ? [['submit', null], ['reject', { reason: allowReason(note.value) }]] : [['reject', { reason: allowReason(note.value) }]], card) }, 'Tolak')));
        } else if (canSubmit(p, cfg.userId, cfg.canApprove)) {
            card.append(h('div', { class: 'as-actions' },
                h('button', { type: 'button', onclick: () => act(p, [['submit', null]], card) }, 'Ajukan ke PPIC')));
        }
        if (!cfg.live && canDecide(p, cfg.canApprove)) {
            const reason = h('textarea', { id: `r-${p.id}`, rows: 2, maxlength: 500, required: true });
            const decide = (action) => {
                const msg = reasonError(reason.value);
                if (msg) {
                    card.querySelector('.as-err').textContent = msg;
                    reason.focus();
                    return;
                }
                act(p, [[action, { reason: reason.value.trim() }]], card);
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
        else if (cfg.live) {
            // Operasi: kartu muncul di percakapan tepat setelah jawaban asisten.
            const follow = atBottom();
            log.append(card);
            if (follow) toBottom();
        } else plist.prepend(card);
        cards.set(p.id, card);
    }
}
