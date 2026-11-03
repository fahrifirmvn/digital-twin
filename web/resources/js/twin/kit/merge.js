// Menggabungkan mesh statis yang berbagi material menjadi satu draw call per material.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const attrSig = (g) => `${g.index ? 'i' : 'n'}:${Object.keys(g.attributes).sort().join(',')}`;

function hiddenChain(o, root) {
    for (let p = o; p && p !== root.parent; p = p.parent) if (!p.visible) return true;
    return false;
}

/**
 * Gabungkan mesh di bawah `root` yang materialnya ada di `shared` (material bersama, tidak pernah diubah saat berjalan).
 * Mesh yang dipilih (userData.code), tersembunyi, atau berskala negatif dibiarkan. Kembalikan geometri baru agar bisa dibuang.
 */
export function mergeStatic(root, shared) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map();
    root.traverse((o) => {
        if (!o.isMesh || o.userData.code || !shared.has(o.material) || hiddenChain(o, root)) return;
        if (o.matrixWorld.determinant() <= 0) return;
        const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${attrSig(o.geometry)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(o);
    });

    const made = [];
    for (const meshes of buckets.values()) {
        if (meshes.length < 2) continue;
        const geoms = meshes.map((o) => {
            const g = o.geometry.clone();
            g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
            return g;
        });
        const merged = mergeGeometries(geoms, false);
        for (const g of geoms) g.dispose();
        if (!merged) continue;
        const [first] = meshes;
        const out = new THREE.Mesh(merged, first.material);
        out.castShadow = first.castShadow;
        out.receiveShadow = first.receiveShadow;
        for (const o of meshes) o.removeFromParent();
        root.add(out);
        made.push(merged);
    }
    return made;
}
