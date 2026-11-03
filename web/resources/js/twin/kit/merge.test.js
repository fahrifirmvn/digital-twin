import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeStatic } from './merge.js';

const box = (mat, x, userData = {}) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    m.position.set(x, 0, 0);
    m.userData = userData;
    return m;
};
const meshes = (root) => { const out = []; root.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };

test('mesh berbagi material digabung menjadi satu, posisi dunia dipertahankan', () => {
    const root = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial();
    const g = new THREE.Group();
    g.position.set(10, 0, 0);
    g.add(box(shared, 1), box(shared, 3));
    root.add(g);
    const made = mergeStatic(root, new Set([shared]));
    const all = meshes(root);
    assert.equal(all.length, 1);
    assert.equal(made.length, 1);
    const bb = new THREE.Box3().setFromBufferAttribute(all[0].geometry.attributes.position);
    assert.deepEqual([bb.min.x, bb.max.x], [10.5, 13.5]);
});

test('mesh terpilih, material milik sendiri, tersembunyi, dan berskala negatif dibiarkan', () => {
    const root = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial();
    const own = new THREE.MeshStandardMaterial();
    const hiddenGroup = new THREE.Group();
    hiddenGroup.visible = false;
    hiddenGroup.add(box(shared, 5), box(shared, 6));
    const flipped = box(shared, 7);
    flipped.scale.x = -1;
    root.add(box(shared, 0), box(shared, 1), box(shared, 2, { code: 'BAY-1' }), box(own, 3), box(own, 4), hiddenGroup, flipped);
    mergeStatic(root, new Set([shared]));
    const all = meshes(root);
    // gabungan (2 dari shared) + terpilih + 2 milik sendiri + 2 tersembunyi + 1 terbalik
    assert.equal(all.length, 1 + 1 + 2 + 2 + 1);
    assert.ok(all.some((o) => o.userData.code === 'BAY-1'));
});

test('bayangan berbeda tidak digabung, satu mesh tunggal tidak diubah', () => {
    const root = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial();
    const a = box(shared, 0);
    const b = box(shared, 1);
    b.castShadow = true;
    root.add(a, b);
    mergeStatic(root, new Set([shared]));
    assert.equal(meshes(root).length, 2);
});
