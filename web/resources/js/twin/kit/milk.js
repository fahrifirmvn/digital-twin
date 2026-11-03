// Susu mengalir di dalam pipa model pabrik: pipa pembawa dibuat transparan, tabung susu mengisi jalur pipa sesuai kemajuan aliran.
// Jalur dan radius dari plant.json `pipes` (layout/pipes.js); tabung dibangun sekali per rute lalu dipakai ulang oleh shader.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPipeGraph, flowRoute } from '../layout/pipes.js';

const POOL = 60;
const FILL = 0.7; // radius susu terhadap radius pipa
const MIN_R = 0.03;
const GLASS = 0.3; // opasitas pipa saat dialiri susu
const FRONT_GAIN = 1.6; // muka susu sampai ujung sebelum aliran selesai
const MILK_COLOR = '#4f8dff';
const HELD_COLOR = '#dc2626';
const UP = new THREE.Vector3(0, 1, 0);

const VERT = `
attribute float aDist;
varying float vDist;
varying vec3 vNormal;
void main() {
    vDist = aDist;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
uniform float uFront;
uniform float uTime;
uniform float uAlpha;
uniform vec3 uColor;
varying float vDist;
varying vec3 vNormal;
void main() {
    if (vDist > uFront) discard;
    float wave = 0.5 + 0.5 * sin((vDist - uTime * 5.0) * 7.0);
    float lit = 0.72 + 0.28 * clamp(dot(normalize(vNormal), normalize(vec3(0.4, 0.7, 0.6))), 0.0, 1.0);
    gl_FragColor = vec4(uColor * lit * (0.82 + 0.18 * wave) + vec3(0.1 * wave), uAlpha);
}`;

/** Tabung per segmen jalur (silinder + bola penyambung di tiap tikungan) dengan atribut aDist = jarak sepanjang rute (meter). */
export function routeGeometry(pts, radii) {
    const parts = [];
    let at = 0;
    const vec = (p) => new THREE.Vector3(p[0], p[1], p[2]);
    for (let k = 0; k < pts.length - 1; k++) {
        const a = vec(pts[k]);
        const b = vec(pts[k + 1]);
        const len = a.distanceTo(b);
        const r = Math.max(MIN_R, radii[k]);
        if (len > 1e-4) {
            const cyl = new THREE.CylinderGeometry(r, r, len, 6, 1, true);
            const y = cyl.attributes.position;
            const d = new Float32Array(y.count);
            for (let i = 0; i < y.count; i++) d[i] = at + y.getY(i) + len / 2;
            cyl.setAttribute('aDist', new THREE.BufferAttribute(d, 1));
            const q = new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize());
            cyl.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
            parts.push(cyl);
        }
        if (k > 0) {
            const ball = new THREE.SphereGeometry(r, 6, 4);
            ball.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(ball.attributes.position.count).fill(at), 1));
            ball.translate(a.x, a.y, a.z);
            parts.push(ball);
        }
        at += len;
    }
    for (const g of parts) g.deleteAttribute('uv');
    return parts.length ? mergeGeometries(parts) : null;
}

/**
 * Susu di dalam pipa. `parent` = grup bersatuan meter model, `nodes` = Map nama node GLB -> objek, `kit` untuk kepemilikan resource.
 * update(links, animate): links dari activeFlowLinks ({from, to, progress, alpha, held}); aliran tanpa rute pipa diabaikan.
 */
export function createMilk({ parent, pipes, taps, nodes, kit }) {
    const graph = buildPipeGraph(pipes, taps);
    const group = new THREE.Group();
    group.renderOrder = 2;
    parent.add(group);

    const glass = new Map();
    for (const p of pipes) {
        const node = nodes.get(p.id);
        if (!node?.isMesh) continue;
        node.material = kit.own(node.material.clone());
        glass.set(p.id, { node, carry: 0 });
    }

    const routes = new Map();
    const geometryOf = (from, to) => {
        const key = `${from}>${to}`;
        if (!routes.has(key)) {
            const r = flowRoute(graph, from, to);
            const geometry = r ? routeGeometry(r.pts, r.segs.map((id) => (id ? graph.pipes.get(id).r * FILL : MIN_R))) : null;
            if (geometry) kit.ownGeometry(geometry);
            routes.set(key, geometry ? { route: r, geometry } : null);
        }
        return routes.get(key);
    };

    const pool = Array.from({ length: POOL }, () => {
        const material = kit.own(new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthWrite: false,
            uniforms: { uFront: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 1 }, uColor: { value: new THREE.Color(MILK_COLOR) } },
        }));
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
        mesh.visible = false;
        mesh.frustumCulled = false;
        group.add(mesh);
        return mesh;
    });

    return {
        group,
        graph,
        update(links, animate = true) {
            const carry = new Map();
            let used = 0;
            const time = animate ? performance.now() / 1000 : 0;
            for (const l of links) {
                if (used >= pool.length) break;
                const entry = geometryOf(l.from, l.to);
                if (!entry) continue;
                const mesh = pool[used++];
                const u = mesh.material.uniforms;
                const a = Math.min(1, l.alpha * 1.8);
                mesh.geometry = entry.geometry;
                mesh.visible = true;
                u.uFront.value = Math.min(1, l.progress * FRONT_GAIN) * entry.route.length;
                u.uAlpha.value = a;
                u.uTime.value = time;
                u.uColor.value.set(l.held ? HELD_COLOR : MILK_COLOR);
                for (const id of entry.route.ids) carry.set(id, Math.max(carry.get(id) ?? 0, a));
            }
            for (let i = used; i < pool.length; i++) pool[i].visible = false;
            for (const [id, g] of glass) {
                const c = carry.get(id) ?? 0;
                if (c === g.carry) continue;
                g.carry = c;
                const m = g.node.material;
                const glassy = c > 0;
                if (m.transparent !== glassy) {
                    m.transparent = glassy;
                    m.needsUpdate = true;
                }
                m.depthWrite = !glassy;
                m.opacity = 1 - (1 - GLASS) * c;
            }
        },
    };
}
