import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAssistantText } from './assistant-format.js';

test('assistant text parses paragraphs, emphasis, headings, and ordered/unordered lists', () => {
    assert.deepEqual(parseAssistantText('**Ringkasan**\n\n1. Pantau *KPI*\n2. Periksa `run_id`\n\n- Aman\n- Stabil'), [
        { type: 'paragraph', content: [{ type: 'strong', text: 'Ringkasan' }] },
        { type: 'ol', items: [
            [{ type: 'text', text: 'Pantau ' }, { type: 'em', text: 'KPI' }],
            [{ type: 'text', text: 'Periksa ' }, { type: 'code', text: 'run_id' }],
        ] },
        { type: 'ul', items: [[{ type: 'text', text: 'Aman' }], [{ type: 'text', text: 'Stabil' }]] },
    ]);
    assert.deepEqual(parseAssistantText('### Catatan\nBaris kedua'), [
        { type: 'heading', level: 3, content: [{ type: 'text', text: 'Catatan' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Baris kedua' }] },
    ]);
});

test('assistant formatter treats HTML and links as literal text', () => {
    assert.deepEqual(parseAssistantText('<script>alert(1)</script> [tautan](javascript:alert(1))'), [
        { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script> [tautan](javascript:alert(1))' }] },
    ]);
});

test('splitEntityRefs detects plant assets and truck codes while preserving plain text', async () => {
    const { splitEntityRefs } = await import('./assistant-format.js');
    assert.deepEqual(splitEntityRefs('Tangki TK-RAW-1 dan truk TRK-04 menuju BAY-2.'), [
        { type: 'text', text: 'Tangki ' },
        { type: 'entity', text: 'TK-RAW-1', code: 'TK-RAW-1' },
        { type: 'text', text: ' dan truk ' },
        { type: 'entity', text: 'TRK-04', code: 'TRK-04' },
        { type: 'text', text: ' menuju ' },
        { type: 'entity', text: 'BAY-2', code: 'BAY-2' },
        { type: 'text', text: '.' },
    ]);
    assert.deepEqual(splitEntityRefs('Teks biasa tanpa kode.'), [
        { type: 'text', text: 'Teks biasa tanpa kode.' },
    ]);
});

