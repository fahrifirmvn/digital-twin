// Zona Proses: data tidak boleh dipasang sebagai HTML; hanya ikon konstan yang boleh.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const DIR = new URL('./', import.meta.url);
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const files = readdirSync(DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
const SINKS = /outerHTML|document\.write|\beval\s*\(|new Function|srcdoc|dangerouslySet/;

test('modul proses tidak memakai sink berbahaya atau atribut URL dari data', () => {
    for (const f of files) {
        const src = strip(readFileSync(new URL(f, DIR), 'utf8'));
        assert.doesNotMatch(src, SINKS, f);
        assert.doesNotMatch(src, /\b(href|src|action|formaction)\s*:/, f);
        assert.doesNotMatch(src, /setAttribute\(\s*['"]on/, f);
    }
});

test('innerHTML dan insertAdjacentHTML hanya menerima ikon konstan', () => {
    let n = 0;
    for (const f of files) {
        const src = strip(readFileSync(new URL(f, DIR), 'utf8'));
        for (const m of src.matchAll(/(?:innerHTML\s*=|insertAdjacentHTML\([^,]+,)\s*([^;)]*\)?)/g)) {
            n++;
            assert.match(m[1].trim(), /^(icon|iconBody)\(/, `${f}: ${m[0]}`);
        }
    }
    assert.ok(n > 0);
});

test('ukuran font process.css tidak kurang dari 12 px', () => {
    const css = readFileSync(new URL('../../../css/process.css', import.meta.url), 'utf8');
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)(px|rem|em)/g)];
    assert.ok(sizes.length > 10);
    for (const [, v, unit] of sizes) {
        const px = unit === 'px' ? Number(v) : Number(v) * 16;
        assert.ok(px >= 12, `font-size ${v}${unit}`);
    }
});
