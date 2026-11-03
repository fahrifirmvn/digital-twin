// Peta geografis ala Google Maps: peta dasar MapLibre (OpenFreeMap), jalur jalan nyata, geofence, dan truk tangki 3D (three.js) di atasnya.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import * as THREE from 'three';
import { createKit } from '../kit/ctx.js';
import { paletteOf } from '../kit/palette.js';
import { makeTruck } from '../kit/modules.js';
import { GATE_LL, GEOFENCE_M, ROUTES_LL, geofenceRing } from './geo-real.js';

maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9ece6' } }] };
const ROUTE_COLOR = '#1a73e8';
const UNIT_M = 0.16; // satu unit model truk (74 unit panjang) = 0,16 m, jadi sekitar 12 m
const TRUCK_PX = 68; // panjang truk di layar; diperbesar saat peta menjauh supaya tetap terlihat
const LABEL_LIMIT = 10;

const rad = (d) => (d * Math.PI) / 180;
const metersPerPixel = (zoom, lat) => (78271.517 * Math.cos(rad(lat))) / 2 ** zoom;

class TruckLayer {
    constructor() {
        this.id = 'trucks3d';
        this.type = 'custom';
        this.renderingMode = '3d';
        this.items = new Map();
        this.selected = null;
    }

    onAdd(map, gl) {
        this.map = map;
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();
        this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
        const pal = paletteOf('light');
        this.kit = createKit(pal, { detail: 1 });
        this.scene.add(new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemiPower));
        const sun = new THREE.DirectionalLight(pal.sun, pal.sunPower);
        sun.position.set(-60, 140, 90);
        this.scene.add(sun);
        this.ring = new THREE.Mesh(new THREE.RingGeometry(40, 47, 48), new THREE.MeshBasicMaterial({ color: ROUTE_COLOR, transparent: true, opacity: 0.9, depthWrite: false }));
        this.ring.rotation.x = -Math.PI / 2;
        this.ring.position.y = 0.6;
        const o = maplibregl.MercatorCoordinate.fromLngLat(GATE_LL, 0);
        this.origin = o;
        this.unit = o.meterInMercatorCoordinateUnits();
        if (this.pending) this.sync(...this.pending);
    }

    onRemove() {
        this.kit?.dispose();
        this.renderer?.dispose();
    }

    /** Taruh, putar, dan beri warna truk; truk yang tidak ada lagi dibuang. */
    sync(list, selected) {
        // Layer baru ada setelah gaya peta selesai dimuat; data terakhir dipakai begitu layer siap.
        if (!this.scene) {
            this.pending = [list, selected];
            return;
        }
        const live = new Set(list.map((t) => t.code));
        for (const [code, it] of this.items) {
            if (live.has(code)) continue;
            this.scene.remove(it.group);
            this.items.delete(code);
        }
        for (const t of list) {
            let it = this.items.get(t.code);
            if (!it) {
                it = makeTruck(this.kit);
                this.scene.add(it.group);
                this.items.set(t.code, it);
            }
            it.group.position.set(t.pos.e, 0, -t.pos.n);
            it.group.rotation.y = Math.PI / 2 - rad(t.pos.bearing);
            it.band.material.color.set(t.inGeofence ? '#16a34a' : '#8fb3ff');
        }
        this.selected = selected && this.items.has(selected) ? selected : null;
        this.ring.removeFromParent();
        if (this.selected) this.items.get(this.selected).group.add(this.ring);
        this.map?.triggerRepaint();
    }

    render(gl, args) {
        const zoom = this.map.getZoom();
        const k = Math.max(1, (TRUCK_PX * metersPerPixel(zoom, GATE_LL.lat)) / (74 * UNIT_M));
        for (const it of this.items.values()) it.group.scale.setScalar(k * UNIT_M);
        const s = this.unit;
        const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
        const l = new THREE.Matrix4()
            .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
            .scale(new THREE.Vector3(s, -s, s))
            .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        this.camera.projectionMatrix = m.multiply(l);
        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
    }
}

/** Tombol Semua jalur / Gerbang di sudut peta. */
class ViewControl {
    constructor(actions) {
        this.actions = actions;
    }

    onAdd() {
        this.el = document.createElement('div');
        this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group tw-gm-view';
        for (const [label, fn] of this.actions) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.addEventListener('click', fn);
            this.el.append(b);
        }
        return this.el;
    }

    onRemove() {
        this.el.remove();
    }
}

/** Panah putih bertepi biru untuk arah jalan. */
function arrowImage() {
    const n = 32;
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    const g = c.getContext('2d');
    g.beginPath();
    g.moveTo(9, 7);
    g.lineTo(23, 16);
    g.lineTo(9, 25);
    g.lineTo(13, 16);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#0b4aa8';
    g.lineWidth = 2;
    g.stroke();
    g.fill();
    return g.getImageData(0, 0, n, n);
}

const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
};

export class GeoMap {
    /** Ambil gaya peta dulu (batas 6 dtk); tanpa internet peta langsung memakai latar polos, jalur dan truk tetap tampil. */
    static async create(container, opts = {}) {
        let style = BLANK_STYLE;
        try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 6000);
            const res = await fetch(STYLE_URL, { signal: ctl.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            style = await res.json();
        } catch {
            opts.onFallback?.();
        }
        return new GeoMap(container, { ...opts, style });
    }

    /** onSelect(code) dipanggil saat truk atau labelnya diklik. onFallback() saat peta dasar tidak bisa dimuat. */
    constructor(container, { onSelect, onFallback, style } = {}) {
        this.onSelect = onSelect ?? (() => {});
        this.onFallback = onFallback ?? (() => {});
        this.labels = new Map();
        this.list = [];
        this.selected = null;
        this.styleReady = false;
        this.fellBack = false;
        this.arrivalSig = '';

        const pts = ROUTES_LL.flatMap((r) => r.pts);
        const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
        this.bounds = bounds;
        this.map = new maplibregl.Map({
            container, style: style ?? STYLE_URL, bounds, fitBoundsOptions: { padding: 70 }, pitch: 40, maxPitch: 75,
            attributionControl: { compact: true }, canvasContextAttributes: { antialias: true },
        });
        const map = this.map;
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
        map.addControl(new ViewControl([
            ['Gerbang', () => this.toGate()],
            ['Semua jalur', () => this.toAll()],
        ]), 'bottom-left');
        map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

        this.truckLayer = new TruckLayer();
        this.gate = this.gateMarker();
        map.on('style.load', () => {
            this.styleReady = true;
            this.overlays();
        });
        map.on('error', (e) => {
            if (this.fellBack) return;
            // Gaya sudah tampil tetapi petak peta gagal: beri tahu saja; gaya yang gagal dimuat diganti latar polos.
            if (this.styleReady) {
                if (e.sourceId) {
                    this.fellBack = true;
                    this.onFallback(e.error);
                }
                return;
            }
            this.fellBack = true;
            this.onFallback(e?.error);
            map.setStyle(BLANK_STYLE);
        });
        map.on('dragstart', () => { this.following = false; });
        map.on('click', (e) => this.onSelect(this.pick(e.point)));
        map.on('mousemove', (e) => { map.getCanvas().style.cursor = this.pick(e.point) ? 'pointer' : ''; });
    }

    toGate() {
        this.map.easeTo({ center: [GATE_LL.lng, GATE_LL.lat], zoom: 15, pitch: 55, bearing: 0, duration: 900 });
    }

    toAll() {
        this.map.fitBounds(this.bounds, { padding: 70, pitch: 40, bearing: 0, duration: 900 });
    }

    overlays() {
        const map = this.map;
        const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
        if (!map.getSource('routes')) {
            map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: ROUTES_LL.map((r) => ({ type: 'Feature', properties: { name: r.name }, geometry: { type: 'LineString', coordinates: r.pts } })) } });
            map.addSource('fence', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [geofenceRing()] } } });
        }
        const w = ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7, 18, 13];
        const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer, before); };
        add({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b4aa8', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 10, 18, 17], 'line-opacity': 0.9 } });
        add({ id: 'route-line', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE_COLOR, 'line-width': w } });
        add({ id: 'fence-fill', type: 'fill', source: 'fence', paint: { 'fill-color': ROUTE_COLOR, 'fill-opacity': 0.12 } });
        add({ id: 'fence-line', type: 'line', source: 'fence', paint: { 'line-color': ROUTE_COLOR, 'line-width': 2, 'line-dasharray': [3, 2] } });
        // Panah arah jalan: truk selalu menuju gerbang.
        if (!map.hasImage('route-arrow')) map.addImage('route-arrow', arrowImage(), { pixelRatio: 2 });
        add({ id: 'route-arrows', type: 'symbol', source: 'routes', layout: { 'symbol-placement': 'line', 'symbol-spacing': 110, 'icon-image': 'route-arrow', 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 14, 0.8, 18, 1.1], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map' } });
        if (!map.getLayer(this.truckLayer.id)) map.addLayer(this.truckLayer);
        this.truckLayer.sync(this.list, this.selected);
    }

    gateMarker() {
        const root = el('div', 'tw-gm-gate');
        root.append(el('span', 'tw-gm-gate-pin'));
        this.gateText = el('div', 'tw-gm-gate-txt');
        this.gateText.append(el('b', '', 'Gerbang masuk'), el('small', '', `Geofence ${GEOFENCE_M} m`));
        this.gateArrivals = el('div', 'tw-gm-arr');
        this.gateText.append(this.gateArrivals);
        root.append(this.gateText);
        return new maplibregl.Marker({ element: root, anchor: 'bottom' }).setLngLat([GATE_LL.lng, GATE_LL.lat]).addTo(this.map);
    }

    /** Kode truk terdekat dari titik layar (px) dalam jarak sentuh, atau null. */
    pick(point) {
        let best = null;
        let bd = 34;
        for (const t of this.list) {
            const p = this.map.project([t.pos.lng, t.pos.lat]);
            const d = Math.hypot(p.x - point.x, p.y - point.y);
            if (d <= bd) { bd = d; best = t.code; }
        }
        return best;
    }

    label(t, show) {
        let m = this.labels.get(t.code);
        if (!show) {
            if (m) { m.remove(); this.labels.delete(t.code); }
            return;
        }
        if (!m) {
            const b = el('button', 'tw-gm-pill');
            b.type = 'button';
            b.addEventListener('click', (ev) => { ev.stopPropagation(); this.onSelect(t.code); });
            m = new maplibregl.Marker({ element: b, anchor: 'bottom', offset: [0, -30] }).setLngLat([t.pos.lng, t.pos.lat]).addTo(this.map);
            this.labels.set(t.code, m);
        }
        m.setLngLat([t.pos.lng, t.pos.lat]);
        const b = m.getElement();
        b.textContent = t.plate ?? t.code;
        b.classList.toggle('is-in', t.inGeofence);
        b.classList.toggle('is-sel', t.code === this.selected);
        b.setAttribute('aria-label', `Pilih ${t.plate ?? t.code}`);
    }

    /** list = inboundList(state, GEO_GEOMETRY); arrivals = recentArrivals(state). */
    update(list, arrivals, selected, follow = false) {
        const prev = this.selected;
        if (selected !== prev) this.following = follow;
        this.list = list;
        this.selected = selected;
        this.truckLayer.sync(list, selected);
        const crowded = list.length > LABEL_LIMIT;
        const live = new Set(list.map((t) => t.code));
        for (const code of [...this.labels.keys()]) if (!live.has(code)) this.label({ code }, false);
        for (const t of list) this.label(t, !crowded || t.code === selected || t.progress > 0.5);

        const sig = arrivals.slice(0, 3).map((t) => `${t.code}:${t.ago}`).join(',');
        if (sig !== this.arrivalSig) {
            this.arrivalSig = sig;
            this.gateArrivals.replaceChildren(...arrivals.slice(0, 3).map((t) => el('span', '', `\u2713 ${t.plate ?? t.code} tiba`)));
        }
        const cur = selected && list.find((t) => t.code === selected);
        if (cur && selected !== prev) this.map.easeTo({ center: [cur.pos.lng, cur.pos.lat], zoom: Math.max(this.map.getZoom(), 13), duration: 700 });
        else if (cur && this.following && !this.map.isMoving()) this.map.easeTo({ center: [cur.pos.lng, cur.pos.lat], duration: 400 });
    }

    resize() {
        this.map.resize();
    }
}
