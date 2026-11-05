const heading = /^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/;
const unordered = /^\s*[-*+]\s+(.+)$/;
const ordered = /^\s*\d+[.)]\s+(.+)$/;
const inlinePattern = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|\*[^*\n]+?\*)/g;

function isBlockStart(line) {
    return heading.test(line) || unordered.test(line) || ordered.test(line);
}

function inlineParts(text) {
    const parts = [];
    let start = 0;
    for (const match of text.matchAll(inlinePattern)) {
        const index = match.index ?? 0;
        if (index > start) parts.push({ type: 'text', text: text.slice(start, index) });
        const token = match[0];
        const type = token.startsWith('**') || token.startsWith('__') ? 'strong' : token.startsWith('`') ? 'code' : 'em';
        const trim = type === 'strong' ? 2 : 1;
        parts.push({ type, text: token.slice(trim, -trim) });
        start = index + token.length;
    }
    if (start < text.length) parts.push({ type: 'text', text: text.slice(start) });
    return parts;
}

/** Parse a conservative Markdown subset; output contains text only and never executable markup. */
export function parseAssistantText(value) {
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length;) {
        if (!lines[i].trim()) {
            i++;
            continue;
        }
        const title = heading.exec(lines[i]);
        if (title) {
            blocks.push({ type: 'heading', level: title[1].length, content: inlineParts(title[2]) });
            i++;
            continue;
        }
        const firstItem = unordered.exec(lines[i]) ?? ordered.exec(lines[i]);
        if (firstItem) {
            const type = unordered.test(lines[i]) ? 'ul' : 'ol';
            const items = [];
            while (i < lines.length) {
                const item = (type === 'ul' ? unordered : ordered).exec(lines[i]);
                if (!item) break;
                items.push(inlineParts(item[1]));
                i++;
            }
            blocks.push({ type, items });
            continue;
        }
        const paragraph = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) paragraph.push(lines[i++]);
        blocks.push({ type: 'paragraph', content: inlineParts(paragraph.join('\n')) });
    }
    return blocks;
}

const ENTITY_RE = /\b(TK-(?:RAW|STO|MIX|CIP)-\d+|SILO-\d+|BAY-\d+|DEG-\d+|THM-\d+|SEP-\d+|STE-\d+|ASEP-\d+|LINE-\d+|LAB(?:-\d+)?|TRK-\d+|T-\d{2,4})\b/g;

/** Split plain text into text and interactive entity tokens (assets/trucks) without HTML sinks. */
export function splitEntityRefs(text) {
    const str = String(text ?? '');
    const out = [];
    let start = 0;
    for (const match of str.matchAll(ENTITY_RE)) {
        const idx = match.index ?? 0;
        if (idx > start) out.push({ type: 'text', text: str.slice(start, idx) });
        out.push({ type: 'entity', text: match[1], code: match[1] });
        start = idx + match[0].length;
    }
    if (start < str.length) out.push({ type: 'text', text: str.slice(start) });
    return out.length ? out : [{ type: 'text', text: str }];
}

