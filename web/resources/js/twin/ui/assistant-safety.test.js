// Teks dari server/LLM tidak boleh pernah dipasang sebagai HTML atau URL: hanya textContent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Komentar dibuang supaya yang diperiksa hanya kode.
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const SINKS = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc|dangerouslySet/;

test('drawer asisten tidak memakai sink HTML atau eval', () => {
    for (const file of ['assistant.js', 'assistant-model.js']) assert.doesNotMatch(read(file), SINKS, file);
});

test('drawer asisten tidak memasang atribut URL atau handler dari data', () => {
    const src = read('assistant.js');
    assert.doesNotMatch(src, /\b(href|src|action|formaction|srcdoc)\s*:/);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]on/);
});

test('pembuat elemen memasang anak string sebagai teks', () => {
    const dom = read('dom.js');
    assert.match(dom, /el\.append\(/);
    assert.doesNotMatch(dom.split('export function chipEl')[0], SINKS);
});
