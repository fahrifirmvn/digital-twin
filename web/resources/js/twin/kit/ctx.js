// Alat bantu pembangun mesh: geometri dan material di-cache supaya modul berulang murah.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export function createKit(palette, { detail = 1 } = {}) {
    const mats = new Map();
    const geos = new Map();
    const texs = new Map();
    const owned = [];
    const kit = { palette, detail };

    /** Jumlah segmen melengkung setelah diskalakan tier kualitas. */
    kit.seg = (n, min = 6) => Math.max(min, Math.round(n * detail));

    kit.geo = (key, make) => {
        let g = geos.get(key);
        if (!g) geos.set(key, (g = make()));
        return g;
    };
    kit.mat = (color, rough = 0.85) => {
        const key = `${color}|${rough}`;
        let m = mats.get(key);
        if (!m) mats.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 })));
        return m;
    };
    /** Material milik satu objek (untuk warna status yang berubah). */
    kit.unique = (color, rough = 0.5) => {
        const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
        owned.push(m);
        return m;
    };
    /** Material bawaan model glTF yang diklon; ikut dibuang bersama kit. */
    kit.own = (m) => {
        owned.push(m);
        return m;
    };
    kit.basic = (color, params = {}) => {
        const m = new THREE.MeshBasicMaterial({ color, ...params });
        owned.push(m);
        return m;
    };
    kit.tex = (key, make) => {
        let t = texs.get(key);
        if (!t) {
            t = make();
            t.colorSpace = THREE.SRGBColorSpace;
            texs.set(key, t);
        }
        return t;
    };
    kit.canvasTex = (key, w, h, draw) => kit.tex(key, () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        draw(c.getContext('2d'), w, h);
        return new THREE.CanvasTexture(c);
    });

    kit.shade = (m, cast = true) => {
        m.castShadow = cast;
        m.receiveShadow = true;
        return m;
    };
    kit.mesh = (geometry, material) => kit.shade(new THREE.Mesh(geometry, material));

    kit.rbox = (w, h, d, color, r = 2, rough) => {
        const rr = Math.max(Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01), 0.05);
        const sg = kit.seg(3, 1);
        return kit.mesh(kit.geo(`rb|${w}|${h}|${d}|${rr}|${sg}`, () => new RoundedBoxGeometry(w, h, d, sg, rr)), kit.mat(color, rough));
    };
    kit.rboxAt = (parent, w, h, d, color, x, yBase, z, r = 2, rough) => {
        const m = kit.rbox(w, h, d, color, r, rough);
        m.position.set(x, yBase + h / 2, z);
        parent.add(m);
        return m;
    };
    kit.cyl = (r, h, color, seg = 40, rough) => {
        const n = kit.seg(seg);
        return kit.mesh(kit.geo(`cy|${r}|${h}|${n}`, () => new THREE.CylinderGeometry(r, r, h, n)), kit.mat(color, rough));
    };
    kit.sphere = (r, color, ws = 16, hs = 10, rough) => {
        const w = kit.seg(ws);
        const h = kit.seg(hs, 4);
        return kit.mesh(kit.geo(`sp|${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h)), kit.mat(color, rough));
    };
    kit.flat = (parent, w, d, color, x, y, z, rough) => {
        const m = new THREE.Mesh(kit.geo(`pl|${w}|${d}`, () => new THREE.PlaneGeometry(w, d)), kit.mat(color, rough));
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, y, z);
        m.receiveShadow = true;
        parent.add(m);
        return m;
    };

    // Bayangan kontak lembut di bawah objek; murah dan ikut bergerak bersama truk.
    kit.contact = (parent, x, z, w, d, rot = 0, y = 0.12) => {
        const tex = kit.canvasTex('blob', 128, 128, (g) => {
            const gr = g.createRadialGradient(64, 64, 6, 64, 64, 64);
            gr.addColorStop(0, `rgba(${palette.blob},${palette.blobAlpha})`);
            gr.addColorStop(1, `rgba(${palette.blob},0)`);
            g.fillStyle = gr;
            g.fillRect(0, 0, 128, 128);
        });
        if (!kit.blobMat) kit.blobMat = kit.basic(0xffffff, { map: tex, transparent: true, depthWrite: false });
        const m = new THREE.Mesh(kit.geo(`pl|${w}|${d}`, () => new THREE.PlaneGeometry(w, d)), kit.blobMat);
        m.rotation.x = -Math.PI / 2;
        m.rotation.z = rot;
        m.position.set(x, y, z);
        parent.add(m);
        return m;
    };

    /** Material bersama (tidak pernah diubah saat berjalan), aman untuk menggabungkan mesh. */
    kit.staticMaterials = () => new Set([...mats.values(), ...(kit.blobMat ? [kit.blobMat] : [])]);
    kit.ownGeometry = (g) => geos.set(`merged|${geos.size}`, g);

    kit.dispose = () => {
        for (const g of geos.values()) g.dispose();
        for (const m of [...mats.values(), ...owned]) m.dispose();
        for (const t of texs.values()) t.dispose();
        geos.clear();
        mats.clear();
        texs.clear();
        owned.length = 0;
    };

    return kit;
}
