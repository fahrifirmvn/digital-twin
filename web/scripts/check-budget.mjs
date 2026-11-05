// Anggaran ukuran bundle (kB, sebelum gzip / gzip). Baseline F0: scene3d 571.5/142.5, run 14.7/6.4, app js 92.8/25.9, app css 33.2/6.6.
// F3: run js/css membesar karena UI panggung Twin (stage, pin, sheet, token V7).
// F3b: halaman dipisah jadi Dashboard + Twin; kode dan CSS bersama (TopBar, kartu, token) masuk chunk "shell".
// P4: mode Simulasi (log perintah, dampak vs dasar, form cabang, lompat kejadian) menambah twin js dan css bersama.
// P5: intervensi PPIC (usulan, keputusan, skor) menambah twin js dan css bersama.
// Maps geografis: peta MapLibre + truk 3D dimuat malas hanya di halaman Maps (chunk geomap); maps.js memuat data jalur nyata.
// Zona Proses: papan alur live dari replay dimuat malas (chunk zona-proses).
// Dashboard: pratinjau 3D dimuat malas dari chunk scene3d (home.js hanya memuatnya bila perangkat mampu).
// Jalankan setelah `npm run build`: `npm run budget`.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIR = new URL('../public/build/assets/', import.meta.url).pathname;
const BUDGET = [
    { name: 'scene3d', ext: '.js', raw: 700, gz: 190 },
    { name: 'twin', ext: '.js', raw: 52, gz: 19 },
    { name: 'zona-proses', ext: '.js', raw: 40, gz: 14 },
    { name: 'zona-proses', ext: '.css', raw: 12, gz: 3.5 },
    { name: 'dashboard', ext: '.js', raw: 10, gz: 4.5 },
    { name: 'maps', ext: '.js', raw: 12, gz: 5.0 },
    { name: 'geomap', ext: '.js', raw: 1120, gz: 305 },
    { name: 'geomap', ext: '.css', raw: 75, gz: 11 },
    { name: 'home', ext: '.js', raw: 8, gz: 3.5 },
    { name: 'shell', ext: '.js', raw: 24, gz: 10 },
    { name: 'shell', ext: '.css', raw: 44, gz: 10 },
    { name: 'app', ext: '.js', raw: 100, gz: 30 },
    { name: 'app', ext: '.css', raw: 40, gz: 8 },
];

const files = readdirSync(DIR);
let failed = false;
for (const b of BUDGET) {
    const re = new RegExp(`^${b.name}-[\\w-]+\\${b.ext}$`);
    const file = files.find((f) => re.test(f));
    if (!file) { console.log(`HILANG  ${b.name}${b.ext}`); failed = true; continue; }
    const buf = readFileSync(join(DIR, file));
    const raw = buf.length / 1000;
    const gz = gzipSync(buf).length / 1000;
    const ok = raw <= b.raw && gz <= b.gz;
    if (!ok) failed = true;
    console.log(`${ok ? 'OK    ' : 'LEWAT '} ${b.name}${b.ext}  ${raw.toFixed(1)}/${b.raw} kB  gz ${gz.toFixed(1)}/${b.gz} kB`);
}
process.exit(failed ? 1 : 0);
