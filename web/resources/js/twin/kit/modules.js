// Builder modul dunia gaya V6. Koordinat: a = x, b = z, y ke atas. Semua modul murni prosedural.
import * as THREE from 'three';
import { PLACEHOLDER_SIZE } from '../layout/zones.js';
import { BUILDING, SILO_RADIUS, buildingWalls, curbRects, dashSegments, hallGeom, padWidth } from '../layout/layout.js';
import { instantiate } from './models.js';

const R = SILO_RADIUS;

/** Truk tangki; pita biru di tangki membawa warna status, lampu kuning di atap kabin. */
export function makeTruck(kit) {
    const custom = instantiate('truck', kit);
    if (custom) {
        const { group, status, picks, size } = custom;
        group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        kit.contact(group, 0, 0, size.x * 1.05, size.z * 2, 0, 1.05);
        return { group, band: status, tank: picks[0], picks };
    }
    const { rboxAt, cyl, mesh, geo, mat, unique, palette: C } = kit;
    const g = new THREE.Group();
    rboxAt(g, 54, 4, 14, C.slate, 0, 4, 0, 1.2);
    for (const x of [-20, -12, 18]) {
        for (const z of [-8.5, 8.5]) {
            const wheel = cyl(4.5, 3.5, C.glass, 24);
            wheel.rotation.x = Math.PI / 2;
            wheel.position.set(x, 4.5, z);
            const rim = cyl(2.4, 3.8, C.rail, 20);
            rim.rotation.x = Math.PI / 2;
            rim.position.set(x, 4.5, z);
            g.add(wheel, rim);
        }
    }
    for (const x of [-16, 18]) for (const z of [-8, 8]) rboxAt(g, x < 0 ? 15 : 11, 2.4, 4, C.white, x, 9, z * 1.06, 1.1);

    const tank = mesh(geo(`capsule|9|18|${kit.detail}`, () => new THREE.CapsuleGeometry(9, 18, kit.seg(8, 3), kit.seg(28))), mat(C.steel, 0.5));
    tank.rotation.z = Math.PI / 2;
    tank.position.set(-10, 17, 0);
    g.add(tank);
    const band = cyl(9.15, 4, C.paleBlue, 32);
    band.material = unique(C.paleBlue, 0.85);
    band.rotation.z = Math.PI / 2;
    band.position.set(3, 17, 0);
    g.add(band);
    for (const x of [-20, -12, -4]) {
        const hatch = kit.sphere(2.7, C.rail);
        hatch.scale.y = 0.55;
        hatch.position.set(x, 26, 0);
        g.add(hatch);
    }
    rboxAt(g, 8, 8, 4, C.steelDark, -21, 8, 9.5, 1.5);
    rboxAt(g, 4, 4, 6, C.slate, 10.5, 6, 0, 1);
    rboxAt(g, 16, 19, 20, C.blue, 20, 5, 0, 4);
    rboxAt(g, 15, 3, 19, C.white, 20, 24, 0, 1.4);
    rboxAt(g, 3, 5, 18, C.white, 29, 5, 0, 1.4);
    rboxAt(g, 0.8, 10, 14, C.glass, 28.2, 11.5, 0, 0.3);
    rboxAt(g, 0.7, 2, 12, C.glass, 29.4, 7, 0, 0.3);
    const lamp = cyl(2, 2, C.amber, 16);
    lamp.position.set(20, 28, 0);
    g.add(lamp);

    // Truk bergerak: tidak ikut bayangan matahari statis, diganti bayangan kontak.
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    kit.contact(g, 0, 0, 74, 28, 0, 1.05);
    return { group: g, band, tank, picks: [tank] };
}

/** Silo: jendela level di sisi +z, kerah atas membawa warna status. */
export function makeSilo(kit) {
    const custom = instantiate('silo', kit);
    if (custom) return { group: custom.group, body: custom.picks[0], picks: custom.picks, collar: custom.status, setLevel: custom.setLevel };
    const { rboxAt, cyl, mesh, geo, mat, unique, palette: C } = kit;
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
        const an = (i * Math.PI * 2) / 3 + 0.5;
        rboxAt(g, 8, 6, 8, C.slate, Math.cos(an) * 15, 0, Math.sin(an) * 15, 2);
    }
    const body = cyl(R, 95, C.steel, 64, 0.45);
    body.position.y = 6 + 47.5;
    g.add(body);
    const dome = mesh(geo('dome', () => new THREE.SphereGeometry(R, kit.seg(64), kit.seg(16, 4), 0, Math.PI * 2, 0, Math.PI / 2)), mat(C.dome, 0.45));
    dome.scale.y = 10 / R;
    dome.position.y = 101;
    g.add(dome);
    const ring = cyl(6.5, 2, C.rail, 24);
    ring.position.y = 110;
    const cap = cyl(4, 4, C.white, 24);
    cap.position.y = 112;
    const collar = cyl(R + 0.5, 8, C.paleBlue, 64);
    collar.material = unique(C.paleBlue, 0.85);
    collar.position.y = 93;
    g.add(ring, cap, collar);
    for (const y of [38, 69]) {
        const band = cyl(R + 0.35, 3, C.steelDark, 64);
        band.position.y = y;
        g.add(band);
    }
    const hatch = cyl(6, 2.4, C.steel, 28);
    hatch.rotation.z = Math.PI / 2;
    hatch.position.set(R + 0.3, 28, 0);
    const hatchRing = cyl(7, 1.6, C.rail, 28);
    hatchRing.rotation.z = Math.PI / 2;
    hatchRing.position.set(R - 0.2, 28, 0);
    g.add(hatch, hatchRing);
    for (let i = 0; i < 4; i++) {
        const an = (i * Math.PI) / 2 + Math.PI / 4;
        const bolt = kit.sphere(1.4, C.rail, 10, 8);
        bolt.position.set(R + 1.8, 28 + Math.sin(an) * 4.2, Math.cos(an) * 4.2);
        g.add(bolt);
    }
    for (const x of [-3.5, 3.5]) rboxAt(g, 1.8, 74, 2, C.rail, x, 12, -R - 0.4, 0.6);
    for (let i = 0; i < 5; i++) rboxAt(g, 8, 2, 2, C.rail, 0, 16 + i * 14, -R - 0.4, 0.6);

    const wx = 4;
    const wz = Math.sqrt(R * R - wx * wx);
    rboxAt(g, 11, 82, 2.6, C.rail, wx, 6, wz - 0.2, 1);
    rboxAt(g, 7, 78, 2.9, C.white, wx, 8, wz + 0.05, 1.2);
    const lip = cyl(5.5, 1.4, C.rail, 24);
    lip.rotation.x = Math.PI / 2;
    lip.position.set(wx, 93, wz + 0.4);
    const sock = cyl(4.3, 1.8, C.white, 24);
    sock.rotation.x = Math.PI / 2;
    sock.position.set(wx, 93, wz + 0.7);
    g.add(lip, sock);
    const pipe = cyl(2.5, 12, C.slate, 16);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(-10, 12, R + 4);
    const wheel = cyl(4, 1.2, C.paleBlue, 20);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(-10, 12, R + 10.5);
    g.add(pipe, wheel);

    // Isi level: kotak setinggi jendela (74), diskalakan dari dasar.
    const pivot = new THREE.Group();
    pivot.position.set(wx, 10, wz + 1.7);
    const fill = new THREE.Mesh(kit.geo('fill', () => new THREE.BoxGeometry(4.6, 1, 1.4)), unique(C.paleBlue, 0.4));
    fill.position.y = 0.5;
    pivot.add(fill);
    pivot.visible = false;
    g.add(pivot);
    return { group: g, body, picks: [body], collar, fill, pivot };
}

export const ASEP_DX = 16;
export const ASEP_GAUGE = 20;

/** Modul proses hilir sederhana per jenis; `band` membawa warna status. Kembalikan juga tinggi titik aliran (`h`). */
export function makeUnit(kit, kind) {
    const custom = instantiate(kind, kit);
    if (custom) return { group: custom.group, body: custom.picks[0], picks: custom.picks, band: custom.status, h: custom.size.y, asep: custom.asep };
    const { rboxAt, cyl, sphere, unique, palette: C } = kit;
    const g = new THREE.Group();
    const bandMat = () => unique(C.paleBlue, 0.85);
    let body;
    let band;
    let h = 40;
    let asep = null;
    let asepGauge = null;
    if (kind === 'DEG') {
        rboxAt(g, 30, 5, 30, C.slate, 0, 0, 0, 1.5);
        body = cyl(13, 44, C.steel, 40, 0.45);
        body.position.y = 5 + 22;
        band = cyl(13.4, 6, C.paleBlue, 40);
        band.position.y = 40;
        const cap = cyl(4, 5, C.white, 20);
        cap.position.y = 52;
        const pipe = cyl(2, 16, C.slate, 14);
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(18, 14, 0);
        g.add(body, band, cap, pipe);
        h = 56;
    } else if (kind === 'THM') {
        rboxAt(g, 40, 4, 26, C.slate, 0, 0, 0, 1.5);
        body = kit.rbox(34, 28, 16, C.steel, 2, 0.45);
        body.position.y = 4 + 14;
        band = kit.rbox(34.4, 4, 16.4, C.paleBlue, 1);
        band.position.y = 30;
        g.add(body, band);
        for (const x of [-18, 18]) rboxAt(g, 3, 32, 20, C.steelDark, x, 4, 0, 1);
        const pipe = cyl(2, 14, C.slate, 14);
        pipe.rotation.x = Math.PI / 2;
        pipe.position.set(8, 12, 14);
        g.add(pipe);
        h = 40;
    } else if (kind === 'SEP') {
        rboxAt(g, 40, 6, 26, C.slate, 0, 0, 0, 1.5);
        body = cyl(10, 28, C.steel, 32, 0.45);
        body.rotation.z = Math.PI / 2;
        body.position.set(-2, 17, 0);
        band = cyl(10.4, 6, C.paleBlue, 32);
        band.rotation.z = Math.PI / 2;
        band.position.set(-2, 17, 0);
        g.add(body, band);
        rboxAt(g, 9, 12, 12, C.steelDark, 17, 6, 0, 1.5);
        h = 34;
    } else if (kind === 'STE') {
        rboxAt(g, 52, 4, 36, C.slate, 0, 0, 0, 1.5);
        body = cyl(10, 56, C.steel, 36, 0.45);
        body.position.set(-14, 4 + 28, 0);
        band = cyl(10.4, 6, C.paleBlue, 36);
        band.position.set(-14, 48, 0);
        const tank = sphere(10, C.white, 20, 12, 0.5);
        tank.material = unique(C.white, 0.5);
        tank.position.set(ASEP_DX, 16, 0);
        // Pengukur level di sisi depan tangki: alur tetap, isi diskalakan dari dasar (tinggi ASEP_GAUGE).
        const track = rboxAt(g, 4.4, ASEP_GAUGE + 2, 1.4, C.slate, ASEP_DX, 8, 11.6, 0.6);
        const pivot = new THREE.Group();
        pivot.position.set(ASEP_DX, 9, 12.5);
        const fill = new THREE.Mesh(kit.geo('fill', () => new THREE.BoxGeometry(4.6, 1, 1.4)), unique(C.paleBlue, 0.4));
        fill.scale.set(0.6, 0.01, 1);
        fill.position.y = 0.005;
        pivot.add(fill);
        pivot.visible = false;
        g.add(pivot);
        asepGauge = { track, pivot, fill };
        const pipe = cyl(1.8, 20, C.slate, 12);
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(0, 22, 0);
        g.add(body, band, tank, pipe);
        h = 66;
        asep = { dx: ASEP_DX, h: 28, body: tank, gauge: asepGauge };
    } else {
        rboxAt(g, 30, 5, 12, C.slate, 0, 0, 0, 1.5);
        body = kit.rbox(10, 22, 12, C.steel, 1.5, 0.45);
        body.position.set(-8, 5 + 11, 0);
        band = kit.rbox(10.4, 4, 12.4, C.paleBlue, 1);
        band.position.set(-8, 21, 0);
        g.add(body, band);
        h = 34;
    }
    band.material = bandMat();
    return { group: g, body, picks: [body], band, h, asep };
}

/** Node tahap yang belum ada di model simulasi: kotak abu transparan dengan label; tanpa status dan tanpa pipa. */
export function makePlaceholder(kit, ph) {
    const { palette: C } = kit;
    const [w, d] = PLACEHOLDER_SIZE;
    const g = new THREE.Group();
    g.position.set(ph.at[0], 0, ph.at[1]);
    const box = new THREE.Mesh(
        kit.geo(`ph|${w}|${d}`, () => new THREE.BoxGeometry(w, 22, d)),
        kit.basic(C.concrete, { transparent: true, opacity: 0.45, depthWrite: false }),
    );
    box.position.y = 11;
    const tex = kit.canvasTex(`ph|${ph.id}|${C.name}`, 256, 96, (c, cw, ch) => {
        c.font = '600 30px system-ui, sans-serif';
        c.textAlign = 'center';
        c.fillStyle = C.name === 'dark' ? '#e2e8f0' : '#1d2733';
        c.fillText(ph.label, cw / 2, 36);
        c.font = '22px system-ui, sans-serif';
        c.fillStyle = C.name === 'dark' ? '#94a3b8' : '#64748b';
        c.fillText('belum dimodelkan', cw / 2, 70);
    });
    const label = new THREE.Mesh(kit.geo('phl', () => new THREE.PlaneGeometry(56, 21)), kit.basic(0xffffff, { map: tex, transparent: true, depthWrite: false }));
    label.position.y = 34;
    // Hadap kamera isometrik (normal ke arah 1,1,1); lookAt tidak dipakai karena label belum punya induk.
    label.rotation.order = 'YXZ';
    label.rotation.set(-Math.asin(1 / Math.sqrt(3)), Math.PI / 4, 0);
    g.add(box, label);
    return { group: g };
}

/** Bay: N pintu bernomor di dinding selatan bangunan; lingkaran status di belakang nomor tiap bay. Dinding dan atap dari makeBuilding. */
export function makeHall(kit, hall) {
    const { rboxAt, geo, palette: C } = kit;
    const geom = hallGeom(hall);
    const { W, cx, cz, left, zf, doors } = geom;
    const g = new THREE.Group();
    rboxAt(g, W + 4, 4, 112, C.concrete, cx, 0, cz, 1.5, 1);

    const bays = new Map();
    doors.forEach((d) => {
        rboxAt(g, 44, 34, 1.4, C.rail, d.a, 4, zf + 0.4, 1);
        const door = rboxAt(g, 40, 32, 1.6, C.white, d.a, 4, zf + 0.8, 1);
        for (let k = 1; k < 4; k++) rboxAt(g, 40, 0.7, 0.8, C.rail, d.a, 4 + k * 8, zf + 1.7, 0.2);
        const n = Number(d.code.split('-')[1]);
        const tex = kit.canvasTex(`bay-badge|${n}`, 128, 128, (c) => {
            c.fillStyle = C.blue;
            c.beginPath();
            c.arc(64, 64, 62, 0, 7);
            c.fill();
            c.fillStyle = '#fff';
            c.font = '700 78px Inter, Arial, sans-serif';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(String(n), 64, 70);
        });
        const badge = new THREE.Mesh(geo('badge', () => new THREE.CircleGeometry(9, 32)), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
        badge.position.set(d.a, 45, zf + 0.9);
        const ring = new THREE.Mesh(geo('badge-ring', () => new THREE.RingGeometry(9.2, 11.8, 40)), kit.basic(C.rail));
        ring.position.set(d.a, 45, zf + 0.7);
        g.add(badge, ring);
        bays.set(d.code, { code: d.code, a: d.a, ring, door });
    });

    const pillars = [left + 8, left + 30, ...doors.slice(1).map((d, i) => (doors[i].a + d.a) / 2), doors.at(-1).a + 35];
    for (const a of pillars) rboxAt(g, 3, 44, 1, C.concrete, a, 5, zf + 0.3, 0.4);
    kit.contact(g, cx + 8, cz + 6, W + 40, 150);

    // Apron di depan pintu: lantai beton, garis biru, pemisah lajur.
    const { a0, a1, b0, b1 } = geom.apron;
    const acx = (a0 + a1) / 2;
    const acz = (b0 + b1) / 2;
    rboxAt(g, a1 - a0, 0.8, b1 - b0, C.concrete, acx, 0, acz, 0.3, 1);
    kit.flat(g, a1 - a0, 3, C.blue, acx, 0.95, b0 + 1.5);
    kit.flat(g, a1 - a0, 3, C.blue, acx, 0.95, b1 - 1.5);
    kit.flat(g, 3, b1 - b0, C.blue, a0 + 1.5, 0.95, acz);
    kit.flat(g, 3, b1 - b0, C.blue, a1 - 1.5, 0.95, acz);
    for (const a of [...doors.map((d) => d.a - 33), doors.at(-1).a + 33]) kit.flat(g, 2, 64, C.apronLine, a, 0.95, zf + 36);
    return { group: g, geom, bays };
}

/**
 * Bangunan produksi tunggal: dinding luar dan atap datar. Dari luar tertutup; `setInside(true)` membuka atap dan membuat dinding
 * transparan supaya isi (bay, tangki, proses) terlihat. `meshes` dipakai kamera untuk klik 2x.
 * `height` mengganti tinggi dinding bawaan; `doors` ({a, b, w}) melubangi dinding utara-selatan di titik itu (tinggi pintu `doorH`).
 */
export function makeBuilding(kit, parts, { height = BUILDING.height, doors = [], doorH = 45 } = {}) {
    const { palette: C } = kit;
    const H = height;
    const wallMat = kit.unique(C.white, 0.8);
    wallMat.transparent = true;
    const roofMat = kit.unique(C.paleBlue, 0.7);
    const trimMat = kit.unique(C.roofLine, 0.6);
    const group = new THREE.Group();
    const walls = new THREE.Group();
    const roof = new THREE.Group();
    const meshes = [];
    const add = (parent, a0, a1, b0, b1, y0, h, mat) => {
        const m = new THREE.Mesh(kit.geo(`bb|${a1 - a0}|${h}|${b1 - b0}`, () => new THREE.BoxGeometry(a1 - a0, h, b1 - b0)), mat);
        m.position.set((a0 + a1) / 2, y0 + h / 2, (b0 + b1) / 2);
        kit.shade(m);
        parent.add(m);
        meshes.push(m);
    };
    for (const w of buildingWalls(parts)) {
        const gaps = doors
            .filter((d) => d.a >= w.a0 - 1 && d.a <= w.a1 + 1 && d.b > w.b0 && d.b < w.b1)
            .sort((x, y) => x.b - y.b);
        let from = w.b0;
        for (const d of gaps) {
            if (d.b - d.w / 2 > from) add(walls, w.a0, w.a1, from, d.b - d.w / 2, 0, H, wallMat);
            add(walls, w.a0, w.a1, d.b - d.w / 2, d.b + d.w / 2, doorH, H - doorH, wallMat);
            from = d.b + d.w / 2;
        }
        if (from < w.b1) add(walls, w.a0, w.a1, from, w.b1, 0, H, wallMat);
    }
    for (const p of parts) {
        add(roof, p.a0 - 2, p.a1 + 2, p.b0 - 2, p.b1 + 2, H, 5, roofMat);
        add(roof, p.a0 + 10, p.a1 - 10, p.b0 + (p.b1 - p.b0) / 2 - 1, p.b0 + (p.b1 - p.b0) / 2 + 1, H + 5, 1.2, trimMat);
    }
    group.add(walls, roof);
    const setInside = (inside) => {
        roof.visible = !inside;
        wallMat.opacity = inside ? 0.14 : 1;
        wallMat.depthWrite = !inside;
        for (const m of meshes) m.castShadow = !inside;
    };
    return { group, meshes, setInside };
}

/** Pos jaga, palang dan tiang lampu; digambar dengan koordinat V6 lalu digeser ke posisi gerbang. */
export function makeGate(kit, gate) {
    const { rboxAt, cyl, mesh, geo, mat, palette: C } = kit;
    const g = new THREE.Group();
    g.position.set(gate.at[0] - 400, 0, gate.at[1]);
    rboxAt(g, 16, 10, 100, C.white, 400, 46, 0, 3);
    for (const z of [-46, 46]) rboxAt(g, 8, 46, 8, C.blue, 400, 0, z, 2);
    const shield = new THREE.Shape();
    shield.moveTo(-5, 5);
    shield.lineTo(5, 5);
    shield.lineTo(5, -1);
    shield.quadraticCurveTo(5, -5, 0, -7);
    shield.quadraticCurveTo(-5, -5, -5, -1);
    shield.lineTo(-5, 5);
    const shieldGeo = geo('gate-shield', () => new THREE.ExtrudeGeometry(shield, { depth: 1.2, bevelEnabled: true, bevelSize: 0.8, bevelThickness: 0.6, bevelSegments: 2 }));
    for (const z of [-24, 0, 24]) {
        const m = mesh(shieldGeo, mat(C.blue, 0.5));
        m.rotation.y = Math.PI / 2;
        m.position.set(408.2, 51, z);
        g.add(m);
    }
    rboxAt(g, 34, 30, 26, C.white, 408, 0, -62, 4);
    rboxAt(g, 36, 3, 28, C.blue, 408, 30, -62, 1.5);
    rboxAt(g, 22, 12, 1, C.lavGlass, 408, 10, -48.6, 2);
    for (let i = 0; i < 6; i++) rboxAt(g, 3, 3, 9.3, i % 2 ? C.white : C.alert, 416, 22, -49 + 4.65 + i * 9.3, 0.8);
    rboxAt(g, 6, 20, 6, C.rail, 416, 0, -47, 2);
    const pole = cyl(1.4, 40, C.slate, 12);
    pole.position.set(385, 20, 40);
    g.add(pole);
    rboxAt(g, 8, 5, 5, C.white, 385, 40, 40, 1.5);
    kit.contact(g, 400, 0, 30, 110, Math.PI / 2);
    return { group: g };
}

/** Area tunggu: pad beton dengan petak bergaris miring kuning per slot. */
export function makePad(kit, pad) {
    const { rboxAt, palette: C } = kit;
    const g = new THREE.Group();
    const [cx, cz] = pad.at;
    rboxAt(g, padWidth(pad.slots), 1, 80, C.concrete, cx, 0, cz, 0.4, 1);
    const tex = kit.canvasTex('pad-stripes', 520, 760, (c, w, h) => {
        c.fillStyle = C.stripeBg;
        c.fillRect(0, 0, w, h);
        c.strokeStyle = C.stripe;
        c.lineWidth = 50;
        for (let i = -h; i < w; i += 100) {
            c.beginPath();
            c.moveTo(i, h);
            c.lineTo(i + h, 0);
            c.stroke();
        }
    });
    const first = cx - ((pad.slots - 1) * 60) / 2;
    for (let i = 0; i < pad.slots; i++) {
        const a = first + i * 60;
        const m = new THREE.Mesh(kit.geo('pad-slot', () => new THREE.PlaneGeometry(52, 76)), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
        m.rotation.x = -Math.PI / 2;
        m.position.set(a, 1.05, cz);
        m.receiveShadow = true;
        g.add(m);
        rboxAt(g, 24, 3, 4, C.white, a, 1, cz + 34, 1);
    }
    for (let i = 0; i <= pad.slots; i++) kit.flat(g, 2, 80, C.white, first - 30 + i * 60, 1.1, cz);
    return { group: g };
}

/** Gedung lab dengan labu ungu di atap; digambar dengan koordinat V6 lalu digeser. */
export function makeLab(kit, lab) {
    const { rboxAt, cyl, mesh, palette: C } = kit;
    const g = new THREE.Group();
    g.position.set(lab.at[0] - 372, 0, lab.at[1] - 658);
    rboxAt(g, 116, 1.4, 80, C.labPave, 372, 0, 658, 4, 1);
    rboxAt(g, 56, 40, 56, C.white, 360, 1, 658, 8);
    rboxAt(g, 32, 27, 56, C.white, 408, 1, 658, 8);
    rboxAt(g, 57, 6, 57, C.purple, 360, 31, 658, 3);
    rboxAt(g, 33, 6, 57, C.purple, 408, 23, 658, 3);
    for (const [w, d, x, z] of [[56, 3, 360, 630.5], [56, 3, 360, 685.5], [3, 56, 332.5, 658], [3, 56, 387.5, 658]]) rboxAt(g, w, 3, d, C.white, x, 41, z, 1);
    for (const [w, d, x, z] of [[32, 3, 408, 631.5], [32, 3, 408, 684.5], [3, 56, 423.5, 658]]) rboxAt(g, w, 3, d, C.white, x, 29, z, 1);
    const win = (w, h, x, y, z) => {
        rboxAt(g, w + 3, h + 3, 1.2, C.white, x, y - 1.5, z, 1.2);
        rboxAt(g, w, h, 1.6, C.lavGlass, x, y, z + 0.3, 1.2);
    };
    win(18, 14, 345, 12, 686.2);
    win(18, 14, 374, 12, 686.2);
    win(14, 12, 408, 9, 686.2);
    rboxAt(g, 1, 20, 16, C.rail, 424.5, 1, 650, 1.4);
    rboxAt(g, 1.4, 17, 13, C.white, 425, 2, 650, 1.2);
    rboxAt(g, 8, 3, 24, C.white, 428, 24.5, 650, 1.2);
    rboxAt(g, 1.4, 9, 14, C.lavGlass, 425, 12, 672, 1);
    rboxAt(g, 4, 1.5, 12, C.white, 426.5, 10.5, 672, 0.6);
    rboxAt(g, 10, 8, 8, C.white, 404, 1.4, 692, 2);
    rboxAt(g, 10.6, 2.4, 8.6, C.purple, 404, 9.2, 692, 1);
    const pedestal = cyl(10, 4, C.white, 40);
    pedestal.position.set(360, 47, 658);
    g.add(pedestal);
    const profile = [[0, 0], [6.5, 0], [7, 1], [6.6, 3], [2.6, 14], [2.4, 17.5], [3.5, 18], [3.5, 20], [2.6, 20]].map(([r, y]) => new THREE.Vector2(r, y));
    const flask = mesh(kit.geo('flask', () => new THREE.LatheGeometry(profile, kit.seg(40))), new THREE.MeshStandardMaterial({ color: C.purple, roughness: 0.35, side: THREE.DoubleSide }));
    flask.position.set(360, 49, 658);
    g.add(flask);
    kit.contact(g, 372, 662, 120, 80);
    return { group: g };
}

/** Pohon, tiang lampu dan kerucut: dekor tanpa perilaku. */
export function makeDecor(kit, item) {
    const { cyl, mesh, geo, mat, palette: C } = kit;
    const g = new THREE.Group();
    g.position.set(item.at[0], 0, item.at[1]);
    if (item.kind === 'tree') {
        const trunk = cyl(1.5, 7, C.slate, 10);
        trunk.position.y = 3.5;
        const crown = kit.sphere(6.5, C.tree, 20, 14);
        crown.position.y = 12;
        g.add(trunk, crown);
        kit.contact(g, 3, 0, 18, 14);
    } else if (item.kind === 'pole') {
        const pole = cyl(1.2, 30, C.slate, 10);
        pole.position.y = 15;
        const head = kit.sphere(3.2, C.white, 14, 10);
        head.position.y = 31;
        g.add(pole, head);
        kit.contact(g, 2, 0, 8, 6);
    } else if (item.kind === 'cone') {
        const cone = mesh(geo('cone', () => new THREE.ConeGeometry(3, 10, 20)), mat(C.orange));
        cone.position.y = 5;
        const base = kit.rbox(8, 1.4, 8, C.orange, 0.5);
        base.position.y = 0.7;
        g.add(cone, base);
    }
    return { group: g };
}

/** Aspal, trotoar dan marka jalan dari denah. */
export function makeRoads(kit, roads) {
    const { rboxAt, palette: C } = kit;
    const g = new THREE.Group();
    for (const r of roads) {
        const from = r.from;
        const to = r.to;
        const a0 = Math.min(from[0], to[0]);
        const a1 = Math.max(from[0], to[0]);
        const b0 = Math.min(from[1], to[1]);
        const b1 = Math.max(from[1], to[1]);
        const horizontal = from[1] === to[1];
        const w = r.width;
        const [la0, la1, lb0, lb1] = horizontal ? [a0, a1, b0 - w / 2, b1 + w / 2] : [a0 - w / 2, a1 + w / 2, b0, b1];
        rboxAt(g, la1 - la0, 0.8, lb1 - lb0, C.asphalt, (la0 + la1) / 2, 0, (lb0 + lb1) / 2, 0.3, 1);
    }
    for (const c of curbRects(roads)) rboxAt(g, c.a1 - c.a0, 1.8, c.b1 - c.b0, C.curb, (c.a0 + c.a1) / 2, 0, (c.b0 + c.b1) / 2, 0.8, 1);
    for (const d of dashSegments(roads)) {
        if (d.axis === 'a') kit.flat(g, 12, 3, C.white, d.a, 0.95, d.b);
        else kit.flat(g, 3, 12, C.white, d.a, 0.95, d.b);
    }
    return { group: g };
}
