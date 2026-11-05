import { h } from './dom.js';

export const QA_RESULT_FIELDS = [
    ['ph', 'pH'],
];

const DISPOSITIONS = new Set(['return_supplier', 'controlled_disposal']);
const ACTIONS = new Set(['retest', 'release', 'reject']);

export function qaResultsDl(results) {
    return h('dl', {}, QA_RESULT_FIELDS.flatMap(([field, label]) => {
        const value = results[field];
        return [h('dt', {}, label), h('dd', {}, value == null ? '—' : String(value))];
    }));
}

export function qaActions(t, { active = false, canQa = false, minute = 0 } = {}) {
    if (!active || !canQa || t?.status !== 'qa_hold') return [];
    const q = t.qa;
    if (!q || q.status === 'testing' || q.status === 'released' || q.status === 'rejected') return [];
    if (q.expires_min != null && minute >= q.expires_min) return [];
    if (q.status === 'confirmed') return q.category === 'hazard' ? ['reject'] : ['release', 'reject'];
    if (q.status !== 'held') return [];
    if (q.category === 'hazard') return ['reject'];
    const attempted = (t.qaHistory ?? []).some((event) => event.status === 'testing');
    return attempted ? ['reject'] : ['retest', 'reject'];
}

export function qaPayload({ requestId, runId, truck, action, reason, disposition = '', results = null }) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(requestId ?? '')) throw new Error('ID permintaan QA tidak valid.');
    if (!Number.isInteger(Number(runId)) || Number(runId) < 1) throw new Error('Run tidak valid.');
    if (!truck) throw new Error('Kode truk wajib diisi.');
    if (!ACTIONS.has(action)) throw new Error('Tindakan QA tidak valid.');
    const why = String(reason ?? '').trim();
    if (why.length < 5 || why.length > 200) throw new Error('Alasan harus 5–200 karakter.');

    const payload = {
        request_id: requestId,
        run_id: Number(runId),
        truck,
        action,
        reason: why,
    };
    if (action === 'reject') {
        if (!DISPOSITIONS.has(disposition)) throw new Error('Pilih disposisi penolakan.');
        payload.disposition = disposition;
    }
    if (action === 'retest') {
        if (!results || QA_RESULT_FIELDS.some(([key]) => !['number', 'string'].includes(typeof results[key]) || (typeof results[key] === 'string' && !results[key].trim()) || !Number.isFinite(Number(results[key])) || Number(results[key]) < 0 || Number(results[key]) > 14)) {
            throw new Error('Isi nilai pH yang valid.');
        }
        payload.results = {
            ph: Number(results.ph),
        };
    }
    return payload;
}

export function qaPendingKey(runId, truck) {
    return `twin.qa.pending.${runId}.${truck}`;
}

export function readQaPending(storage, key) {
    try {
        const value = storage?.getItem(key);
        if (!value) return null;
        const record = JSON.parse(value);
        return record?.payload?.request_id ? record : null;
    } catch {
        return null;
    }
}

export function writeQaPending(storage, key, record) {
    try {
        storage?.setItem(key, JSON.stringify(record));
        return true;
    } catch {
        return false;
    }
}

export function clearQaPending(storage, key) {
    try {
        storage?.removeItem(key);
    } catch {
        // Storage may be unavailable in private browsing contexts.
    }
}

export function qaRequestId(cryptoApi = globalThis.crypto) {
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    if (!cryptoApi?.getRandomValues) throw new Error('Browser tidak dapat membuat ID permintaan QA.');
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
