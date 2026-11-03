import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../../../css/twin.css', import.meta.url), 'utf8');

function tokens(selector) {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => [m[1], `#${m[2].length === 3 ? [...m[2]].map((c) => c + c).join('') : m[2]}`]));
}

const light = tokens('.tw');
const dark = { ...light, ...tokens(".tw[data-theme='dark']") };

function lum(hex) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

// Teks normal wajib 4.5:1 (WCAG AA); batas komponen UI dan ikon 3:1.
const TONES = ['brand', 'ok', 'warn', 'bad', 'lab'];
const textPairs = (t) => [
    ['ink/bg', t.ink, t.bg], ['ink/card', t.ink, t.card], ['ink/hover', t.ink, t.hover],
    ['mute/bg', t.mute, t.bg], ['mute/card', t.mute, t.card], ['mute/mute-soft', t.mute, t['mute-soft']],
    ['on-brand/brand', t['on-brand'], t.brand], ['mute/hover', t.mute, t.hover],
    ...TONES.map((n) => [`${n}-text/${n}-soft`, t[`${n}-text`], t[`${n}-soft`]]),
];
const edgePairs = (t) => [
    ...TONES.map((n) => [`${n} tepi/${n}-soft`, t[`${n}-edge`] ?? t[n], t[`${n}-soft`]]),
    ['line-strong/mute-soft', t['line-strong'], t['mute-soft']],
];

function failures(pairs, min) {
    return pairs.filter(([, fg, bg]) => ratio(fg, bg) < min).map(([label, fg, bg]) => `${label} ${ratio(fg, bg).toFixed(2)}`);
}

for (const [name, t] of [['terang', light], ['gelap', dark]]) {
    test(`kontras teks AA (4.5:1) tema ${name}`, () => {
        assert.deepEqual(failures(textPairs(t), 4.5), []);
    });
    test(`kontras tepi/ikon (3:1) tema ${name}`, () => {
        assert.deepEqual(failures(edgePairs(t), 3), []);
    });
}
