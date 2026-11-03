// Panel "Usulan sistem" di mode Simulasi: PPIC menyetujui/mengubah/menolak usulan, menahan truk di gerbang, atau
// mencoba melepas truk yang ditahan gate (akan diblokir dan dicatat). Semua teks lewat textContent.
import { h } from './dom.js';
import { clock, clockOfDay, runMinuteOf } from './format.js';

const VERDICT = { approve: 'Disetujui', change: 'Diubah', reject: 'Ditolak' };
const hhmm = clockOfDay;

/** decide(kind, {truck, bay?, start_min?, duration_min?}) -> Promise; update(rows, minute) menggambar ulang bila perlu. */
export function createInterventionPanel({ list, bays, decide, reasonInput, errEl }) {
    let sig = '';
    let busy = false;
    const editing = new Set();
    reasonInput.addEventListener('input', () => { errEl.textContent = ''; });

    function act(kind, args) {
        const reason = reasonInput.value.trim();
        errEl.textContent = '';
        if (reason.length < 5) {
            errEl.textContent = 'Isi alasan keputusan dulu (minimal 5 huruf).';
            reasonInput.focus();
            return;
        }
        busy = true;
        list.setAttribute('aria-busy', 'true');
        Promise.resolve(decide(kind, args, reason)).finally(() => {
            busy = false;
            list.removeAttribute('aria-busy');
        });
    }

    const btn = (label, onclick, extra = {}) => h('button', { type: 'button', class: 'tw-iv-btn', onclick: () => !busy && onclick(), ...extra }, label);

    function waitingCard(r) {
        const edit = h('div', { class: 'tw-iv-edit', hidden: !editing.has(r.code) });
        const bay = h('select', { 'aria-label': `Bay untuk ${r.code}` }, bays.map((b) => h('option', { value: b, selected: b === r.proposal?.bay }, b)));
        const time = h('input', { type: 'time', 'aria-label': `Jam mulai bongkar ${r.code}`, value: r.proposal ? hhmm(r.proposal.unloadM) : '' });
        edit.append(bay, time, btn('Terapkan', () => {
            const [hh, mm] = time.value.split(':').map(Number);
            const args = { truck: r.code, bay: bay.value };
            if (Number.isFinite(hh) && r.proposal) args.start_min = runMinuteOf(r.proposal.unloadM, hh, mm);
            act('plan_change', args);
        }, { class: 'tw-iv-btn primary' }));
        return h('li', { class: 'tw-iv-card', dataset: { verdict: r.verdict ?? '' } },
            h('div', { class: 'tw-iv-head' }, h('b', {}, r.code), ` ${r.plate ?? ''} · ${r.stage} sejak ${clock(r.sinceM)}`, r.verdict ? h('span', { class: 'tw-iv-chip' }, VERDICT[r.verdict]) : null),
            h('p', {}, r.proposal
                ? `Usulan: ${r.proposal.bay}, bongkar ${hhmm(r.proposal.unloadM)}${r.proposal.analyst ? `, analis ${r.proposal.analyst}` : ''}`
                : 'Usulan ditolak: truk dilayani menurut waktu tiba.'),
            h('div', { class: 'tw-iv-actions' },
                btn('Setujui', () => act('plan_approve', { truck: r.code })),
                btn('Ubah', () => { editing.has(r.code) ? editing.delete(r.code) : editing.add(r.code); edit.hidden = !editing.has(r.code); }),
                btn('Tolak', () => act('plan_reject', { truck: r.code }))),
            edit);
    }

    const simple = (r, text, button) => h('li', { class: 'tw-iv-card' },
        h('div', { class: 'tw-iv-head' }, h('b', {}, r.code), ` ${r.plate ?? ''}`), h('p', {}, text), h('div', { class: 'tw-iv-actions' }, button));

    function group(title, items) {
        return items.length ? [h('h4', {}, title), h('ul', { class: 'tw-iv-list' }, items)] : [];
    }

    function update(rows, minute) {
        const next = JSON.stringify([rows, [...editing]]);
        if (next === sig || list.contains(document.activeElement)) return;
        sig = next;
        const kids = [
            ...group('Usulan sistem untuk truk yang menunggu', rows.waiting.map(waitingCard)),
            ...group('Menuju gerbang', rows.inbound.map((r) => simple(r, r.hold ? `Ditahan PPIC (tiba ${clock(r.etaM)})` : `Perkiraan tiba ${clock(r.etaM)}`,
                r.hold ? btn('Lepas', () => act('truck_release', { truck: r.code })) : btn('Tahan 60 mnt', () => act('truck_hold', { truck: r.code, duration_min: 60 }))))),
            ...group('Ditahan PPIC di gerbang', rows.gate.map((r) => simple(r, `Menunggu sejak ${clock(r.sinceM)}`, btn('Lepas', () => act('truck_release', { truck: r.code }))))),
            ...group('Ditahan gate SOP', rows.g1.map((r) => simple(r, `G1 TAHAN${r.reason ? `: ${r.reason}` : ''}. Gate tidak bisa dilewati; mencoba melepas akan diblokir dan dihitung pelanggaran.`,
                btn('Coba lepas', () => act('truck_release', { truck: r.code }), { class: 'tw-iv-btn danger' })))),
        ];
        list.replaceChildren(...(kids.length ? kids : [h('p', { class: 'tw-hint' }, `Tidak ada usulan yang menunggu pada ${clock(minute)}.`)]));
    }

    return { update };
}
