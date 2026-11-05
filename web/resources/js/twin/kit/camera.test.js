import assert from 'node:assert/strict';
import test from 'node:test';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ORBIT_LIMITS, createCamera } from './camera.js';

test('kamera bisa mengorbit melewati 180 derajat dari kedua arah', () => {
    const camera = createCamera();
    const controls = new OrbitControls(camera);
    Object.assign(controls, ORBIT_LIMITS);
    for (const angle of [-Math.PI * 0.9, -Math.PI / 2, 0, Math.PI / 2, Math.PI * 0.9]) {
        camera.position.set(Math.sin(angle) * 1500, 1000, Math.cos(angle) * 1500);
        controls.update();
        assert.ok(Math.abs(controls.getAzimuthalAngle() - angle) < 1e-6);
    }
});

test('kemiringan lebih luas tetap tidak menembus tanah atau membalik kamera', () => {
    const camera = createCamera();
    const controls = new OrbitControls(camera);
    Object.assign(controls, ORBIT_LIMITS);
    camera.position.set(1, -1000, 1);
    controls.update();
    assert.ok(camera.position.y > 0);
    assert.ok(controls.getPolarAngle() <= ORBIT_LIMITS.maxPolarAngle + 1e-6);
    assert.ok(ORBIT_LIMITS.minPolarAngle > 0);
    assert.ok(ORBIT_LIMITS.maxPolarAngle < Math.PI / 2);
});
