// Model 3D buatan pengguna (glTF/GLB dari Blender) yang menggantikan modul prosedural bila ada di /models/manifest.json.
// Tanpa manifest atau tanpa berkas, semua modul prosedural tetap dipakai. Konvensi nama node dan cara membuat GLB dari .blend ada di web/scripts/export-blend.py.
import * as THREE from 'three';

/** Sumbu dan ukuran target (satuan dunia) agar model berskala bebas dari Blender pas dengan denah. */
export const FIT = {
    truck: ['x', 74],
    silo: ['y', 112],
    DEG: ['y', 56],
    THM: ['y', 40],
    SEP: ['y', 34],
    STE: ['y', 66],
    LINE: ['y', 34],
};

/** Tapak maksimum (lebar x, dalam z) per jenis, sama dengan slot denah; model diperkecil bila melebihinya. */
export const FOOT = {
    truck: [74, 28],
    silo: [46, 46],
    DEG: [44, 44],
    THM: [44, 44],
    SEP: [44, 44],
    STE: [56, 44],
    LINE: [34, 34],
};

/** Node yang wajib ada agar model dipakai; selain itu model dilewati dan modul prosedural dipakai. */
const REQUIRED = { STE: ['asep'] };

const templates = new Map();

export const modelKinds = () => [...templates.keys()];
export const hasModel = (kind) => templates.has(kind);
export const clearModels = () => templates.clear();

const matcher = (name) => new RegExp(`^${name}([._-]?\\d+)?$`, 'i');

/** Node pertama yang namanya `name` (sufiks numerik Blender seperti `.001` diabaikan). */
export function findNode(root, name) {
    const re = matcher(name);
    let found = null;
    root.traverse((o) => { if (!found && re.test(o.name)) found = o; });
    return found;
}

/** Daftarkan satu model. Kembalikan false (dan abaikan) bila node wajibnya tidak ada atau jenisnya tidak dikenal. */
export function registerModel(kind, scene, opts = {}) {
    if (!FIT[kind]) return false;
    const missing = (REQUIRED[kind] ?? []).filter((n) => !findNode(scene, n));
    if (missing.length) {
        console.warn(`Model "${kind}" dilewati: node ${missing.join(', ')} tidak ada.`);
        return false;
    }
    templates.set(kind, { scene, rotationY: Number(opts.rotationY) || 0, scale: Number(opts.scale) > 0 ? Number(opts.scale) : null });
    return true;
}

const asEntry = (v) => (typeof v === 'string' ? { file: v } : v);

/** Bentuk manifest yang sah: { kind: "berkas.glb" | { file, rotationY?, scale? } }. Kembalikan daftar [kind, entry]. */
export function parseManifest(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
    return Object.entries(json)
        .map(([kind, v]) => [kind, asEntry(v)])
        .filter(([kind, e]) => FIT[kind] && e && typeof e.file === 'string' && /^[\w][\w .-]*\.(glb|gltf)$/i.test(e.file));
}

/** Muat manifest dan semua model yang tercantum. Tidak pernah melempar: kegagalan berarti tetap prosedural. */
export async function loadModels(base = '/models/') {
    let entries = [];
    try {
        const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
        if (!res.ok) return [];
        entries = parseManifest(await res.json());
    } catch {
        return [];
    }
    if (!entries.length) return [];
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    await Promise.all(entries.map(async ([kind, e]) => {
        try {
            const gltf = await loader.loadAsync(`${base}${e.file}`);
            registerModel(kind, gltf.scene, e);
        } catch (err) {
            console.warn(`Model "${kind}" gagal dimuat:`, err?.message ?? err);
        }
    }));
    return modelKinds();
}

function makeSetLevel(node) {
    if (!node) return null;
    const full = node.scale.y;
    return (f) => {
        const show = f != null && f > 0.005;
        node.visible = show;
        if (show) node.scale.y = full * Math.min(1, f);
    };
}

/** Material milik node ini sendiri supaya warna status satu aset tidak memengaruhi salinan lain. */
function ownMaterial(kit, node) {
    const m = Array.isArray(node.material) ? node.material[0] : node.material;
    node.material = kit.own(m.clone());
    return node;
}

/**
 * Buat salinan model untuk `kind`, atau null bila tidak ada.
 * Hasil: { group, status, picks, setLevel, asep, size }.
 * `status` = mesh bernama `status` (material miliknya), atau penanda bulat kecil di atas bila tidak ada.
 * `setLevel(0..1)` memakai node `level` (origin di dasar, dibuat setinggi penuh), null bila tidak ada.
 * `asep` hanya untuk STE: { dx, h, body, setLevel }.
 */
export function instantiate(kind, kit) {
    const tpl = templates.get(kind);
    if (!tpl) return null;
    const [axis, target] = FIT[kind];
    const group = new THREE.Group();
    const inner = new THREE.Group();
    inner.add(tpl.scene.clone(true));
    inner.rotation.y = tpl.rotationY;
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    const [fw, fd] = FOOT[kind];
    const fit = Math.min(size[axis] > 0 ? target / size[axis] : Infinity, size.x > 0 ? fw / size.x : Infinity, size.z > 0 ? fd / size.z : Infinity);
    const s = tpl.scale ?? (Number.isFinite(fit) ? fit : 1);
    inner.scale.setScalar(s);
    inner.position.set(-mid.x * s, -box.min.y * s, -mid.z * s);
    group.add(inner);
    group.updateMatrixWorld(true);

    const picks = [];
    inner.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        picks.push(o);
    });

    let status = findNode(inner, 'status');
    if (status?.isMesh) {
        ownMaterial(kit, status);
    } else {
        status = kit.sphere(3, kit.palette.paleBlue);
        status.material = kit.unique(kit.palette.paleBlue, 0.85);
        status.position.set(0, size.y * s + 4, 0);
        group.add(status);
    }

    const level = findNode(inner, 'level');
    const out = {
        group, status, picks, size: size.clone().multiplyScalar(s),
        setLevel: level?.isMesh ? makeSetLevel(level) : null,
        asep: null,
    };
    if (level?.isMesh) level.visible = false;

    const asep = findNode(inner, 'asep');
    if (asep?.isMesh) {
        ownMaterial(kit, asep);
        const ab = new THREE.Box3().setFromObject(asep);
        const al = findNode(inner, 'asep_level');
        if (al?.isMesh) al.visible = false;
        out.asep = { dx: (ab.min.x + ab.max.x) / 2, h: ab.max.y, body: asep, setLevel: al?.isMesh ? makeSetLevel(al) : null };
    }
    return out;
}
