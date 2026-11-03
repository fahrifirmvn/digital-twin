// Twin 3D (Three.js): dunia gaya V6 dari denah data. Hanya menggambar state dari reducer; tidak memuat logika simulasi.
// API: new TwinScene3D(container, {layout, theme, quality}), draw(state, speed), setLayout(layout), setTheme(name), setQuality(tier), dispose().
// Untuk UI: project(kode) -> titik layar, onFrame() setelah tiap render, onSelect(kode|null) saat diklik, focus(kode)/resetFocus().
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { STATUS_COLORS } from './canvas.js';
import { DEFAULT_LAYOUT } from './layout/default.js';
import { validateLayout } from './layout/layout.js';
import { ORBIT_LIMITS, createCamera, createLights, fitFrustum } from './kit/camera.js';
import { TIERS } from './kit/quality.js';
import { fmtL } from './ui/format.js';
import { makeTruck } from './kit/modules.js';
import { loadModels } from './kit/models.js';
import { buildPlantWorld, loadPlant } from './kit/plant.js';
import { buildWorld } from './kit/world.js';
import { assetVisual } from './scene3d-model.js';
import { activeFlowLinks, placeTrucks, truckSlots } from './sim/intent.js';
import { TruckMover } from './sim/mover.js';

const FLOW_POOL = 60;
const LEAVING_EXTRA = 8;
const SNAP_MIN = 45;
const MAX_DT = 0.1;
const FLOW_ALPHA = 0.7;
export const MILK_HOLD_SEC = 7; // detik nyata susu menempuh pipa; tetap pada semua kecepatan putar
const FLOW_COLOR = '#2563eb';
const HELD_COLOR = '#dc2626';
const FOCUS_ZOOM = 1.8;
const FOCUS_MS = 450;
const TRUCK_PIN_HEIGHT = 34;
const CLICK_SLOP = 6;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const shown = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
};

/** Muat model Blender opsional (public/models/manifest.json) sebelum membuat scene; tidak melempar. */
export { loadModels };
/** Muat model pabrik realistis (plant.glb); null bila tidak ada, lalu denah prosedural dipakai. */
export { loadPlant };

export class TwinScene3D {
    /** Melempar bila WebGL tidak tersedia atau denah tidak valid; pemanggil jatuh kembali ke tampilan 2D. `plant` = hasil loadPlant. */
    constructor(container, { layout = DEFAULT_LAYOUT, theme = 'light', quality = 'high', plant = null } = {}) {
        this.container = container;
        this.plant = plant;
        this.theme = theme;
        this.quality = TIERS[quality] ? quality : 'high';
        this.renderer = new THREE.WebGLRenderer({ antialias: TIERS[this.quality].antialias });
        this.renderer.setPixelRatio(this.pixelRatio());
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.VSMShadowMap;
        this.renderer.shadowMap.autoUpdate = false;
        Object.assign(this.renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
        container.append(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.camera = createCamera();
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        Object.assign(this.controls, { enableDamping: false, screenSpacePanning: true, ...ORBIT_LIMITS });
        this.controls.addEventListener('change', () => this.render());

        this.buildTooltip();
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.renderer.domElement.addEventListener('pointermove', (e) => this.hover(e));
        this.renderer.domElement.addEventListener('pointerleave', () => { this.tip.hidden = true; });
        this.renderer.domElement.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
        this.renderer.domElement.addEventListener('pointerup', (e) => this.click(e));
        this.renderer.domElement.addEventListener('dblclick', (e) => this.enterAt(e));
        this.onFrame = null;
        this.onSelect = null;
        this.onZone = null;
        this.home = null;

        this.setLayout(layout);
        this.resizer = new ResizeObserver(() => this.resize());
        this.resizer.observe(container);
        this.resize();
    }

    /** Bangun ulang dunia dari denah baru; denah tidak valid ditolak sebelum menyentuh dunia lama. */
    setLayout(layout) {
        const errors = validateLayout(layout);
        if (errors.length) throw new Error(`Denah tidak valid: ${errors.join(' ')}`);
        this.clear();
        this.source = layout;
        this.lastM = null;
        const opts = { theme: this.theme, detail: TIERS[this.quality].detail };
        this.world = this.plant ? buildPlantWorld(layout, this.plant, opts) : buildWorld(layout, opts);
        // Denah gerak truk: pada model pabrik berasal dari akses di sekitarnya, bukan dari denah data.
        this.layout = this.world.motion ?? layout;
        this.scene.environment = this.plant ? this.environment() : null;
        this.scene.environmentIntensity = 0.55;
        this.scene.background = new THREE.Color(this.world.palette.ground);
        this.scene.add(this.world.root);
        this.lights = createLights(this.world.bounds, this.world.palette, TIERS[this.quality].shadow);
        this.scene.add(this.lights);
        this.pick = [...this.world.pickables];
        this.world.building.setInside(this.inside);
        this.buildTrucks();
        this.buildFlows();
        this.fit();
        this.renderer.shadowMap.needsUpdate = true;
        if (this.state) this.draw(this.state, this.speed);
        else this.render();
    }

    setTheme(theme) {
        if (theme !== this.theme) {
            this.theme = theme;
            this.rebuild();
        }
    }

    /** Pantulan lingkungan untuk material logam model; dibuat sekali per renderer. */
    environment() {
        if (!this.envMap) {
            const pmrem = new THREE.PMREMGenerator(this.renderer);
            this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
            pmrem.dispose();
        }
        return this.envMap;
    }

    pixelRatio() {
        return Math.min(window.devicePixelRatio || 1, TIERS[this.quality].pixelRatio);
    }

    /** Ganti tier tanpa mengubah kamera; antialias hanya berlaku sejak renderer dibuat. */
    setQuality(quality) {
        if (!TIERS[quality] || quality === this.quality) return;
        this.quality = quality;
        this.renderer.setPixelRatio(this.pixelRatio());
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight, false);
        this.rebuild();
    }

    /** Bangun ulang dunia dengan denah yang sama, mempertahankan kamera dan fokus pengguna. */
    rebuild() {
        const { camera, controls } = this;
        const view = { pos: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom, home: this.home };
        this.setLayout(this.source);
        camera.position.copy(view.pos);
        controls.target.copy(view.target);
        camera.zoom = view.zoom;
        camera.updateProjectionMatrix();
        controls.update();
        this.home = view.home;
        this.render();
    }

    clear() {
        if (!this.world) return;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.scene.remove(this.world.root, this.lights);
        this.world.dispose();
        for (const f of this.flows) {
            this.scene.remove(f.line, f.dot);
            f.line.geometry.dispose();
            f.line.material.dispose();
            f.dot.material.dispose();
        }
        this.flowDot.dispose();
        this.world = null;
    }

    buildTrucks() {
        const { kit, root } = this.world;
        const size = truckSlots(this.layout).capacity + LEAVING_EXTRA;
        this.mover = new TruckMover(this.layout, { maxEntries: size });
        this.slotOf = new Map();
        this.trucks = Array.from({ length: size }, (_, i) => {
            const t = makeTruck(kit);
            t.group.visible = false;
            for (const m of t.picks) {
                m.userData = { truck: i };
                this.pick.push(m);
            }
            root.add(t.group);
            return { ...t, code: '', status: '' };
        });
    }

    buildFlows() {
        this.flowDot = new THREE.SphereGeometry(7, 12, 12);
        this.flows = Array.from({ length: FLOW_POOL }, () => {
            const line = new THREE.Line(
                new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
                new THREE.LineBasicMaterial({ transparent: true }),
            );
            const dot = new THREE.Mesh(this.flowDot, new THREE.MeshBasicMaterial({ transparent: true }));
            line.visible = dot.visible = false;
            line.frustumCulled = false;
            this.scene.add(line, dot);
            return { line, dot };
        });
    }

    buildTooltip() {
        this.tip = document.createElement('div');
        this.tip.style.cssText = 'position:absolute;pointer-events:none;background:#1d2733;color:#fff;font:12px system-ui;padding:3px 8px;border-radius:4px;white-space:nowrap';
        this.tip.hidden = true;
        this.note = document.createElement('div');
        this.note.style.cssText = 'position:absolute;left:8px;bottom:6px;font:12px system-ui;color:#64748b';
        this.container.append(this.tip, this.note);
    }

    fit() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (!w || !h) return;
        cancelAnimationFrame(this.camRaf);
        this.home = null;
        this.controls.target.copy(fitFrustum(this.camera, this.zoneRects(), w / h, 1.06, 0.16));
        this.controls.update();
    }

    /** Jejak zona aktif: semua, Penerimaan, atau Proses (hanya mengubah bingkai kamera, scene tetap satu). */
    zoneRects() {
        return this.world.zones[this.zone ?? 'all'] ?? this.world.footprints;
    }

    /** Di dalam bangunan produksi (zona Proses): atap terbuka dan dinding transparan. */
    get inside() {
        return this.zone === 'process';
    }

    /** Pindah bingkai ke zona 'all' | 'intake' | 'process' dengan animasi kamera; ukuran frustum mengikuti zona. */
    setZone(zone) {
        if (!this.world.zones[zone] || zone === (this.zone ?? 'all')) return;
        this.zone = zone;
        this.world.building.setInside(this.inside);
        this.renderer.shadowMap.needsUpdate = true;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (!w || !h) return;
        const { camera, controls } = this;
        const probe = camera.clone();
        const target = fitFrustum(probe, this.zoneRects(), w / h, 1.06, 0.16);
        this.home = null;
        const zoom = Math.min(ORBIT_LIMITS.maxZoom, Math.max(ORBIT_LIMITS.minZoom, (camera.top - camera.bottom) / (probe.top - probe.bottom)));
        this.glide(target, camera.position.clone().sub(controls.target), zoom);
    }

    /** Masuk ke bangunan (zona Proses) dan beri tahu UI agar tombol zona ikut berubah. */
    enter() {
        this.tip.hidden = true;
        this.setZone('process');
        this.onZone?.('process');
    }

    /** Klik 2x pada dinding atau atap bangunan dari luar: masuk ke proses di dalamnya. */
    enterAt(e) {
        if (this.inside || !this.buildingAt(e)) return;
        this.enter();
    }

    buildingAt(e) {
        const r = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        return this.raycaster.intersectObjects(this.world.building.meshes, false).length > 0;
    }

    /** Titik dunia sebuah kode (aset berjangkar atau truk yang sedang tampil), atau null. */
    pointOf(key) {
        const anchor = this.world.anchors.get(key);
        if (anchor) return anchor;
        const slot = this.slotOf.get(key);
        if (!slot?.group.visible) return null;
        return { a: slot.group.position.x, b: slot.group.position.z, h: TRUCK_PIN_HEIGHT };
    }

    /** Apakah kode punya posisi di scene (aset berjangkar atau truk). */
    has(key) {
        return this.world.anchors.has(key);
    }

    /** Lencana persen isi tampil di semua zona kamera. */
    labelsOn() {
        return true;
    }

    /** Tempat pin truk yang sudah meninggalkan scene (ditolak lab): lab pertama. */
    fallbackKey() {
        return [...this.world.anchors.keys()].find((k) => k.startsWith('LAB:')) ?? null;
    }

    /** Posisi layar (px relatif container) sebuah kode; null bila tak tampil atau di luar bingkai. */
    project(key) {
        const p = this.pointOf(key);
        if (!p) return null;
        const v = new THREE.Vector3(p.a, p.h, p.b).project(this.camera);
        if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) return null;
        return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
    }

    /** Geser dan perbesar kamera ke sebuah kode; inset = lebar px di kanan yang tertutup sheet. */
    focus(key, { inset = 0 } = {}) {
        const p = this.pointOf(key);
        const w = this.container.clientWidth;
        if (!p || !w) return;
        if (p.inside && !this.inside) this.enter();
        const { camera, controls } = this;
        this.home ??= { offset: camera.position.clone().sub(controls.target), target: controls.target.clone(), zoom: camera.zoom };
        const zoom = Math.min(ORBIT_LIMITS.maxZoom, Math.max(this.home.zoom, FOCUS_ZOOM));
        const perPx = (camera.right - camera.left) / zoom / w;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const target = new THREE.Vector3(p.a, 0, p.b).addScaledVector(right, (inset / 2) * perPx);
        this.glide(target, camera.position.clone().sub(controls.target), zoom);
    }

    resetFocus() {
        if (this.home) this.glide(this.home.target, this.home.offset, this.home.zoom);
    }

    /** Zoom satu langkah (faktor f) dalam batas orbit; target kamera tetap. */
    zoomBy(f) {
        const { camera, controls } = this;
        const zoom = Math.min(ORBIT_LIMITS.maxZoom, Math.max(ORBIT_LIMITS.minZoom, camera.zoom * f));
        this.glide(controls.target.clone(), camera.position.clone().sub(controls.target), zoom);
    }

    /** Putar mengelilingi target sebesar rad; melewati batas azimuth kembali ke batas lawannya. */
    rotateStep(rad) {
        const { camera, controls } = this;
        const az = controls.getAzimuthalAngle();
        const { minAzimuthAngle: lo, maxAzimuthAngle: hi } = ORBIT_LIMITS;
        const next = az + rad > hi + 1e-6 ? lo : Math.min(hi, az + rad);
        const offset = camera.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), next - az);
        this.glide(controls.target.clone(), offset, camera.zoom);
    }

    /** Kembali ke bingkai awal seluruh pabrik. */
    resetView() {
        this.fit();
        this.render();
    }

    glide(target, offset, zoom) {
        const { camera, controls } = this;
        cancelAnimationFrame(this.camRaf);
        const from = { target: controls.target.clone(), offset: camera.position.clone().sub(controls.target), zoom: camera.zoom };
        const apply = (k) => {
            controls.target.lerpVectors(from.target, target, k);
            camera.position.copy(controls.target).add(new THREE.Vector3().lerpVectors(from.offset, offset, k));
            camera.zoom = from.zoom + (zoom - from.zoom) * k;
            camera.updateProjectionMatrix();
            controls.update();
            this.render();
        };
        if (reducedMotion()) return apply(1);
        const t0 = performance.now();
        const step = (now) => {
            const k = Math.min(1, (now - t0) / FOCUS_MS);
            apply(1 - (1 - k) ** 3);
            if (k < 1) this.camRaf = requestAnimationFrame(step);
        };
        this.camRaf = requestAnimationFrame(step);
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h, false);
        this.fit();
        this.render();
    }

    /** Terapkan state tampilan (sama dengan Twin Canvas 2D) lalu gambar; snap melompatkan truk ke tujuannya. */
    draw(state, speed, { snap = false } = {}) {
        const jump = this.lastM === null || state.m < this.lastM || state.m - this.lastM > SNAP_MIN;
        this.lastM = state.m;
        this.state = state;
        this.speed = speed;
        for (const [code, handle] of this.world.assets) {
            const v = assetVisual(code, state.assets[code]);
            handle.set(v.status === 'idle' ? null : v.color, v.fill, v.status);
        }

        const { trucks, overflow } = placeTrucks(state, this.layout);
        this.mover.sync(trucks, { snap: snap || jump });
        this.applyPoses();
        if (this.mover.moving) this.startLoop();
        this.note.textContent = overflow > 0 ? `+${overflow} truk antre lainnya` : '';

        const { anchors } = this.world;
        if (this.world.milk) {
            // Model pabrik: susu mengalir di dalam pipa; RT -> BAY dan LINE -> PACK-OUT tidak lewat pipa sehingga tidak digambar.
            this.world.milk.update(activeFlowLinks(state, speed, MILK_HOLD_SEC), !reducedMotion());
            if (!this.raf) this.render();
            return;
        }
        const links = activeFlowLinks(state, speed).filter((l) => anchors.has(l.from) && anchors.has(l.to));
        this.flows.forEach((slot, i) => {
            const f = links[i];
            slot.line.visible = slot.dot.visible = Boolean(f);
            if (!f) return;
            const from = anchors.get(f.from);
            const to = anchors.get(f.to);
            const color = f.held ? HELD_COLOR : FLOW_COLOR;
            const p = slot.line.geometry.attributes.position;
            p.set([from.a, from.h, from.b, to.a, to.h, to.b]);
            p.needsUpdate = true;
            slot.line.material.color.set(color);
            slot.line.material.opacity = f.alpha * FLOW_ALPHA;
            slot.dot.material.color.set(color);
            slot.dot.material.opacity = f.alpha;
            slot.dot.position.set(
                from.a + (to.a - from.a) * f.progress,
                from.h + (to.h - from.h) * f.progress,
                from.b + (to.b - from.b) * f.progress,
            );
        });
        if (!this.raf) this.render();
    }

    /** Pindahkan mesh truk dari pose mover; mesh dipakai ulang per kode truk. */
    applyPoses() {
        const poses = new Map(this.mover.poses().map((p) => [p.code, p]));
        for (const [code, slot] of this.slotOf) {
            if (poses.has(code)) continue;
            slot.group.visible = false;
            slot.code = '';
            this.slotOf.delete(code);
        }
        for (const [code, p] of poses) {
            let slot = this.slotOf.get(code);
            if (!slot) {
                slot = this.trucks.find((s) => !s.code);
                if (!slot) continue;
                slot.code = code;
                slot.group.visible = true;
                this.slotOf.set(code, slot);
            }
            slot.status = p.status;
            slot.group.position.set(p.a, 0, p.b);
            slot.group.rotation.y = p.rot;
            slot.band.material.color.set(STATUS_COLORS[p.status] ?? '#94a3b8');
        }
    }

    // Loop animasi hanya hidup selama ada truk bergerak; selebihnya render dipicu draw().
    startLoop() {
        if (this.raf) return;
        this.lastTick = performance.now();
        this.raf = requestAnimationFrame((t) => this.tick(t));
    }

    tick(now) {
        const dt = Math.min(MAX_DT, (now - this.lastTick) / 1000);
        this.lastTick = now;
        const moving = this.mover.step(dt);
        this.applyPoses();
        this.render();
        this.raf = moving ? requestAnimationFrame((t) => this.tick(t)) : 0;
    }

    render() {
        this.renderer.render(this.scene, this.camera);
        this.onFrame?.();
    }

    /** Kode aset atau truk di bawah kursor, atau null. */
    pickAt(e) {
        const r = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hit = this.raycaster.intersectObjects(this.pick, false).find((h) => shown(h.object) && (this.inside || !h.object.userData.inside));
        if (!hit) return null;
        const { code, truck } = hit.object.userData;
        return code ?? this.trucks[truck].code;
    }

    click(e) {
        const d = this.down;
        this.down = null;
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return;
        this.onSelect?.(this.pickAt(e));
    }

    hover(e) {
        const code = this.state && e.pointerType !== 'touch' ? this.pickAt(e) : null;
        if (!code) {
            const onBuilding = !this.inside && e.pointerType !== 'touch' && this.buildingAt(e);
            this.tip.hidden = !onBuilding;
            if (onBuilding) {
                this.tip.textContent = 'Bangunan produksi · klik 2x untuk masuk';
                const r = this.renderer.domElement.getBoundingClientRect();
                this.tip.style.left = `${e.clientX - r.left + 12}px`;
                this.tip.style.top = `${e.clientY - r.top + 12}px`;
            }
            return;
        }
        const t = this.state.tankers[code];
        if (t) {
            this.tip.textContent = `${code}${t.plate ? ` · ${t.plate}` : ''} · ${t.status}`;
        } else {
            const v = assetVisual(code, this.state.assets[code]);
            this.tip.textContent = `${code} · ${v.status}${v.level != null ? ` · ${fmtL(v.level)}` : ''}`;
        }
        const r = this.renderer.domElement.getBoundingClientRect();
        this.tip.style.left = `${e.clientX - r.left + 12}px`;
        this.tip.style.top = `${e.clientY - r.top + 12}px`;
        this.tip.hidden = false;
    }

    dispose() {
        cancelAnimationFrame(this.camRaf);
        this.resizer.disconnect();
        this.controls.dispose();
        this.clear();
        this.envMap?.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
        this.tip.remove();
        this.note.remove();
    }
}
