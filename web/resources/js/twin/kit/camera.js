// Kamera isometrik ortografis dan pencahayaan dunia.
import * as THREE from 'three';

const VIEW_OFFSET = new THREE.Vector3(1500, 1500, 1500);
export const MAX_HEIGHT = 130;
export const ORBIT_LIMITS = {
    minZoom: 0.5, maxZoom: 6, minPolarAngle: 0.15, maxPolarAngle: Math.PI / 2 - 0.1,
    minAzimuthAngle: -Infinity, maxAzimuthAngle: Infinity,
};

export const boundsCenter = (b) => new THREE.Vector3((b.a0 + b.a1) / 2, 0, (b.b0 + b.b1) / 2);

export function createCamera() {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
    cam.position.copy(VIEW_OFFSET);
    cam.lookAt(0, 0, 0);
    return cam;
}

/**
 * Pas frustum agar semua jejak (alas + tinggi maksimum) tampak dengan margin. Titik bidik dipilih di
 * tengah proyeksi layar supaya ruang kosong di sudut kotak dunia tidak terbuang.
 */
export function fitFrustum(camera, footprints, aspect, margin = 1.06, bottomPad = 0) {
    const probe = camera.clone();
    probe.position.copy(VIEW_OFFSET);
    probe.lookAt(0, 0, 0);
    probe.updateMatrixWorld();
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const v = new THREE.Vector3();
    for (const r of footprints) {
        for (const x of [r.a0, r.a1]) {
            for (const z of [r.b0, r.b1]) {
                for (const y of [0, MAX_HEIGHT]) {
                    v.set(x, y, z).applyMatrix4(probe.matrixWorldInverse);
                    x0 = Math.min(x0, v.x);
                    x1 = Math.max(x1, v.x);
                    y0 = Math.min(y0, v.y);
                    y1 = Math.max(y1, v.y);
                }
            }
        }
    }
    // Ruang kosong di bawah (dock dan kartu panel menutupi tepi bawah): isi scene naik sebesar bottomPad dari tinggi.
    y0 -= bottomPad * (y1 - y0);
    // Pusat layar dalam ruang kamera, dikembalikan ke dunia pada bidang tanah y=0.
    const centre = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0).applyMatrix4(probe.matrixWorld);
    const dir = new THREE.Vector3();
    probe.getWorldDirection(dir);
    const target = centre.addScaledVector(dir, -centre.y / dir.y);
    camera.position.copy(target).add(VIEW_OFFSET);
    camera.lookAt(target);
    camera.zoom = 1;
    camera.updateMatrixWorld();
    const hw = ((x1 - x0) / 2) * margin;
    const hh = ((y1 - y0) / 2) * margin;
    const half = Math.max(hh, hw / aspect);
    Object.assign(camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    camera.updateProjectionMatrix();
    return target;
}

/** Cahaya hemisfer + matahari berbayangan statis; bayangan dipanggang sekali (autoUpdate dimatikan di renderer). */
export function createLights(bounds, palette, shadowSize = 4096) {
    const group = new THREE.Group();
    const c = boundsCenter(bounds);
    const span = Math.hypot(bounds.a1 - bounds.a0, bounds.b1 - bounds.b0);
    const hemi = new THREE.HemisphereLight(palette.hemiSky, palette.hemiGround, palette.hemiPower);
    const sun = new THREE.DirectionalLight(palette.sun, palette.sunPower);
    sun.position.set(c.x - 700, 1300, c.z + 400);
    sun.target.position.copy(c);
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    const half = span / 2 + 120;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 100, far: 4000 });
    sun.shadow.radius = 7;
    sun.shadow.blurSamples = 20;
    sun.shadow.bias = -0.0004;
    group.add(hemi, sun, sun.target);
    return group;
}
