import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const Q = new URLSearchParams(location.search);
const S = Number(Q.get('scale') || 1);
const OUT = Q.get('out') || '';
const W = 1440, H = 1024;
const C = {
  ground: '#EEF1FB', seam: '#E3E8F5', asphalt: '#CDD3E6', curb: '#F1F5F9', concrete: '#E2E8F0',
  labPave: '#E9E4FA', white: '#F8FAFC', blue: '#2F5BEA', paleBlue: '#BFD0FB', steel: '#E1E7F0',
  steelDark: '#C8D1DE', slate: '#334155', glass: '#1E293B', purple: '#7C3AED', amber: '#F59E0B',
  orange: '#F97316', tree: '#9AD9B3', rail: '#CBD5E1', lavGlass: '#E9E4FB',
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W * S, H * S, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(C.ground);

const k = 1 / Math.sqrt(2 / 3);
const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 1, 6000);
cam.zoom = k;
const target = new THREE.Vector3(569.3, 0, 190.7);
cam.position.copy(target).add(new THREE.Vector3(1500, 1500, 1500));
cam.lookAt(target);
cam.updateProjectionMatrix();
cam.updateMatrixWorld();

const proj = (a, b, h = 0) => {
  const v = new THREE.Vector3(a, h, b).project(cam);
  return [Math.round((v.x * 0.5 + 0.5) * W * 10) / 10, Math.round((-v.y * 0.5 + 0.5) * H * 10) / 10];
};

scene.add(new THREE.HemisphereLight('#DDE3FB', '#EEF1FB', 2.3));
const sun = new THREE.DirectionalLight('#FFF7ED', 1.5);
sun.position.set(target.x - 700, 1300, target.z + 400);
sun.target.position.copy(target);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -1100; sc.right = 1100; sc.top = 1100; sc.bottom = -1100; sc.near = 100; sc.far = 4000;
sun.shadow.radius = 7;
sun.shadow.blurSamples = 20;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

const matCache = {};
const mat = (color, rough = 0.85) => matCache[color + rough] ||= new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
const shade = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

const rbox = (w, h, d, color, r = 2, rough) => {
  const rr = Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
  return shade(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.max(rr, 0.05)), mat(color, rough)));
};
const put = (parent, mesh, x, yBase, z, h) => {
  const hh = h ?? (mesh.geometry.parameters?.height ?? 0);
  mesh.position.set(x, yBase + hh / 2, z);
  parent.add(mesh);
  return mesh;
};
const rboxAt = (parent, w, h, d, color, x, yBase, z, r = 2, rough) => put(parent, rbox(w, h, d, color, r, rough), x, yBase, z, h);
const cyl = (r, h, color, seg = 40, rough) => shade(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat(color, rough)));
const flat = (parent, w, d, color, x, y, z, rough) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(color, rough));
  m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true; parent.add(m); return m;
};

const blobTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 6, 64, 64, 64);
  gr.addColorStop(0, 'rgba(142,152,201,0.55)'); gr.addColorStop(1, 'rgba(142,152,201,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const contact = (x, z, w, d, rot = 0) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.rotation.z = rot; m.position.set(x, 0.12, z); scene.add(m);
};

// Ground with soft paving tiles aligned to the a/b axes
{
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = C.ground; g.fillRect(0, 0, 256, 256);
  g.fillStyle = C.seam; g.fillRect(0, 0, 256, 3); g.fillRect(0, 0, 3, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  t.repeat.set(6400 / 64, 6400 / 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(6400, 6400), new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true; scene.add(m);
}

const P = {}; // named anchor points (a, b, h) exported for overlay calibration

// ---------------- Roads ----------------
const road = new THREE.Group(); scene.add(road);
const asphalt = (a0, a1, b0, b1) => rboxAt(road, a1 - a0, 0.8, b1 - b0, C.asphalt, (a0 + a1) / 2, 0, (b0 + b1) / 2, 0.3, 1);
const curb = (a0, a1, b0, b1) => rboxAt(road, a1 - a0, 1.8, b1 - b0, C.curb, (a0 + a1) / 2, 0, (b0 + b1) / 2, 0.8, 1);
asphalt(-320, 483, -28, 28);
asphalt(427, 483, -28, 640);
curb(-320, 427, -34, -28); curb(-320, 427, 28, 34);
curb(483, 489, -34, 308); curb(483, 489, 410, 640);
curb(421, 427, 34, 640);
for (let a = -308; a < 420; a += 24) flat(road, 12, 3, C.white, a + 6, 0.95, 0);
for (let b = 40; b < 630; b += 24) flat(road, 3, 12, C.white, 455, 0.95, b + 6);

// ---------------- Truck ----------------
function makeTruck() {
  const g = new THREE.Group();
  rboxAt(g, 54, 4, 14, C.slate, 0, 4, 0, 1.2);
  for (const x of [-20, -12, 18]) for (const z of [-8.5, 8.5]) {
    const w = cyl(4.5, 3.5, C.glass, 24); w.rotation.x = Math.PI / 2; w.position.set(x, 4.5, z); g.add(w);
    const rim = cyl(2.4, 3.8, C.rail, 20); rim.rotation.x = Math.PI / 2; rim.position.set(x, 4.5, z); g.add(rim);
  }
  for (const x of [-16, 18]) for (const z of [-8, 8]) rboxAt(g, x < 0 ? 15 : 11, 2.4, 4, C.white, x, 9, z * 1.06, 1.1);
  const tank = shade(new THREE.Mesh(new THREE.CapsuleGeometry(9, 18, 8, 28), mat(C.steel, 0.5)));
  tank.rotation.z = Math.PI / 2; tank.position.set(-10, 17, 0); g.add(tank);
  const band = cyl(9.15, 4, C.paleBlue, 32); band.rotation.z = Math.PI / 2; band.position.set(3, 17, 0); g.add(band);
  for (const x of [-20, -12, -4]) {
    const m = shade(new THREE.Mesh(new THREE.SphereGeometry(2.7, 16, 10), mat(C.rail))); m.scale.y = 0.55; m.position.set(x, 26, 0); g.add(m);
  }
  rboxAt(g, 8, 8, 4, C.steelDark, -21, 8, 9.5, 1.5);
  rboxAt(g, 4, 4, 6, C.slate, 10.5, 6, 0, 1);
  rboxAt(g, 16, 19, 20, C.blue, 20, 5, 0, 4);
  rboxAt(g, 15, 3, 19, C.white, 20, 24, 0, 1.4);
  rboxAt(g, 3, 5, 18, C.white, 29, 5, 0, 1.4);
  rboxAt(g, 0.8, 10, 14, C.glass, 28.2, 11.5, 0, 0.3);
  rboxAt(g, 0.7, 2, 12, C.glass, 29.4, 7, 0, 0.3);
  const lamp = cyl(2, 2, C.amber, 16); lamp.position.set(20, 28, 0); g.add(lamp);
  return g;
}
function addTruck(a, b, facing) {
  const t = makeTruck();
  t.position.set(a, 0, b);
  t.rotation.y = facing === 'b' ? -Math.PI / 2 : 0;
  scene.add(t);
  contact(a, b, facing === 'b' ? 28 : 74, facing === 'b' ? 74 : 28);
  return t;
}
const trucks = {
  'T-112': [42, 0, 'a'], 'T-111': [116, 0, 'a'], 'T-110': [190, 0, 'a'], 'T-109': [264, 0, 'a'], 'T-107': [338, 0, 'a'],
  'T-105': [520, 84, 'b'], 'T-106': [580, 84, 'b'], 'T-108': [640, 84, 'b'],
  'T-101': [614, 340, 'b'], 'T-103': [746, 340, 'b'], 'T-104': [520, 640, 'a'],
};
const truckObjs = {};
for (const [id, [a, b, f]] of Object.entries(trucks)) { truckObjs[id] = addTruck(a, b, f); P[id] = [a, b, 0]; }

// ---------------- Gate ----------------
{
  const g = new THREE.Group(); scene.add(g);
  rboxAt(g, 16, 10, 100, C.white, 400, 46, 0, 3);
  for (const z of [-46, 46]) rboxAt(g, 8, 46, 8, C.blue, 400, 0, z, 2);
  for (const z of [-24, 0, 24]) {
    const s = new THREE.Shape();
    s.moveTo(-5, 5); s.lineTo(5, 5); s.lineTo(5, -1); s.quadraticCurveTo(5, -5, 0, -7); s.quadraticCurveTo(-5, -5, -5, -1); s.lineTo(-5, 5);
    const m = shade(new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 1.2, bevelEnabled: true, bevelSize: 0.8, bevelThickness: 0.6, bevelSegments: 2 }), mat(C.blue, 0.5)));
    m.rotation.y = Math.PI / 2; m.position.set(408.2, 51, z); g.add(m);
  }
  rboxAt(g, 34, 30, 26, C.white, 408, 0, -62, 4);
  rboxAt(g, 36, 3, 28, C.blue, 408, 30, -62, 1.5);
  rboxAt(g, 22, 12, 1, C.lavGlass, 408, 10, -48.6, 2);
  for (let i = 0; i < 6; i++) rboxAt(g, 3, 3, 9.3, i % 2 ? C.white : '#DC2626', 416, 22, -49 + 4.65 + i * 9.3, 0.8);
  rboxAt(g, 6, 20, 6, C.rail, 416, 0, -47, 2);
  const pole = cyl(1.4, 40, C.slate, 12); pole.position.set(385, 20, 40); g.add(pole);
  rboxAt(g, 8, 5, 5, C.white, 385, 40, 40, 1.5);
  contact(400, 0, 30, 110, Math.PI / 2);
  P.gate = [400, 0, 56]; P.gatePin = [400, 0, 56];
}

// ---------------- Silos (hero #1) ----------------
const slab = rbox(204, 1.6, 54, C.concrete, 0.8, 1); put(scene, slab, 425, 0, -150, 1.6);
function makeSilo() {
  const g = new THREE.Group();
  const R = 23;
  for (let i = 0; i < 3; i++) {
    const an = i * Math.PI * 2 / 3 + 0.5;
    rboxAt(g, 8, 6, 8, C.slate, Math.cos(an) * 15, 0, Math.sin(an) * 15, 2);
  }
  const body = cyl(R, 95, C.steel, 64, 0.45); body.position.y = 6 + 47.5; g.add(body);
  const dome = shade(new THREE.Mesh(new THREE.SphereGeometry(R, 64, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat('#E8EDF5', 0.45)));
  dome.scale.y = 10 / R; dome.position.y = 101; g.add(dome);
  const ring = cyl(6.5, 2, C.rail, 24); ring.position.y = 110; g.add(ring);
  const cap = cyl(4, 4, C.white, 24); cap.position.y = 112; g.add(cap);
  const collar = cyl(R + 0.5, 8, C.paleBlue, 64); collar.position.y = 93; g.add(collar);
  for (const y of [38, 69]) { const gr = cyl(R + 0.35, 3, C.steelDark, 64); gr.position.y = y; g.add(gr); }
  const hatch = cyl(6, 2.4, C.steel, 28); hatch.rotation.z = Math.PI / 2; hatch.position.set(R + 0.3, 28, 0); g.add(hatch);
  const hr = cyl(7, 1.6, C.rail, 28); hr.rotation.z = Math.PI / 2; hr.position.set(R - 0.2, 28, 0); g.add(hr);
  for (let i = 0; i < 4; i++) {
    const an = i * Math.PI / 2 + Math.PI / 4;
    const bolt = shade(new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 8), mat(C.rail)));
    bolt.position.set(R + 1.8, 28 + Math.sin(an) * 4.2, Math.cos(an) * 4.2); g.add(bolt);
  }
  for (const x of [-3.5, 3.5]) rboxAt(g, 1.8, 74, 2, C.rail, x, 12, -R - 0.4, 0.6);
  for (let i = 0; i < 5; i++) rboxAt(g, 8, 2, 2, C.rail, 0, 16 + i * 14, -R - 0.4, 0.6);
  const wx = 4, wz = Math.sqrt(R * R - wx * wx);
  rboxAt(g, 11, 82, 2.6, C.rail, wx, 6, wz - 0.2, 1);
  rboxAt(g, 7, 78, 2.9, C.white, wx, 8, wz + 0.05, 1.2);
  const lip = cyl(5.5, 1.4, C.rail, 24); lip.rotation.x = Math.PI / 2; lip.position.set(wx, 93, wz + 0.4); g.add(lip);
  const sock = cyl(4.3, 1.8, C.white, 24); sock.rotation.x = Math.PI / 2; sock.position.set(wx, 93, wz + 0.7); g.add(sock);
  const pipe = cyl(2.5, 12, C.slate, 16); pipe.rotation.x = Math.PI / 2; pipe.position.set(-10, 12, R + 4); g.add(pipe);
  const wheel = cyl(4, 1.2, C.paleBlue, 20); wheel.rotation.x = Math.PI / 2; wheel.position.set(-10, 12, R + 10.5); g.add(wheel);
  return g;
}
for (let i = 0; i < 4; i++) {
  const a = 350 + i * 50, b = -150;
  const s = makeSilo(); s.position.set(a, 1.6, b); scene.add(s);
  const R = 23, wx = 4, wz = Math.sqrt(R * R - wx * wx);
  const id = 'TK-0' + (i + 1);
  P[id + ' base'] = [a, b, 0];
  P[id + ' window top'] = [a + wx, b + wz, 1.6 + 8 + 78];
  P[id + ' window bottom'] = [a + wx, b + wz, 1.6 + 8];
  P[id + ' socket'] = [a + wx, b + wz, 1.6 + 93];
  P[id + ' top'] = [a, b, 1.6 + 111];
  contact(a + 6, b - 4, 54, 54);
}

// ---------------- Hall ----------------
{
  const g = new THREE.Group(); scene.add(g);
  const cx = 680, cz = 254;
  rboxAt(g, 244, 4, 112, C.slate, cx, 0, cz, 1.5);
  rboxAt(g, 240, 66, 108, C.white, cx, 4, cz, 8);
  const sh = new THREE.Shape(); sh.moveTo(-60, 0); sh.lineTo(60, 0); sh.lineTo(0, 28); sh.lineTo(-60, 0);
  const rg = new THREE.ExtrudeGeometry(sh, { depth: 244, bevelEnabled: true, bevelSize: 2, bevelThickness: 2, bevelSegments: 3 });
  rg.translate(0, 0, -122);
  const roof = shade(new THREE.Mesh(rg, mat(C.blue, 0.7)));
  roof.rotation.y = Math.PI / 2; roof.position.set(cx, 70, cz); g.add(roof);
  const ridge = shade(new THREE.Mesh(new THREE.CapsuleGeometry(2.4, 238, 4, 12), mat(C.white)));
  ridge.rotation.z = Math.PI / 2; ridge.position.set(cx, 98, cz); g.add(ridge);
  const ang = Math.atan2(28, 60);
  for (const side of [1, -1]) for (const u of [14, 28, 42]) {
    const y = 70 + 28 * (1 - u / 60) + 0.9;
    const ln = rbox(236, 1, 1.6, '#3F6AF2', 0.4); ln.position.set(cx, y, cz + side * u); ln.rotation.x = side * -ang * -1; g.add(ln);
  }
  for (const x of [cx - 40, cx + 40]) { const v = rbox(12, 8, 8, '#3F6AF2', 2); v.position.set(x, 70 + 15, cz - 30); v.rotation.x = -ang; g.add(v); }
  const zf = 308;
  for (const a of [614, 680, 746]) {
    rboxAt(g, 44, 34, 1.4, C.rail, a, 4, zf + 0.4, 1);
    rboxAt(g, 40, 32, 1.6, C.white, a, 4, zf + 0.8, 1);
    for (let i = 1; i < 4; i++) rboxAt(g, 40, 0.7, 0.8, C.rail, a, 4 + i * 8, zf + 1.7, 0.2);
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const x = cv.getContext('2d'); x.fillStyle = C.blue; x.beginPath(); x.arc(64, 64, 62, 0, 7); x.fill();
    x.fillStyle = '#fff'; x.font = '700 78px Inter, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String([614, 680, 746].indexOf(a) + 1), 64, 70);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const bd = new THREE.Mesh(new THREE.CircleGeometry(9, 32), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    bd.position.set(a, 4 + 32 + 9, zf + 0.9); g.add(bd);
  }
  for (const a of [568, 590, 647, 713, 781]) rboxAt(g, 3, 44, 1, C.concrete, a, 5, zf + 0.3, 0.4);
  for (const z of [cz - 30, cz + 30]) rboxAt(g, 1, 44, 3, C.concrete, 800.3, 5, z, 0.4);
  contact(cx + 8, cz + 6, 280, 150);
}

// ---------------- Apron ----------------
{
  const g = new THREE.Group(); scene.add(g);
  rboxAt(g, 337, 0.8, 102, C.concrete, 651.5, 0, 359, 0.3, 1);
  const line = (w, d, x, z) => flat(g, w, d, C.blue, x, 0.95, z);
  line(337, 3, 651.5, 309.5); line(337, 3, 651.5, 408.5); line(3, 102, 484.5, 359); line(3, 102, 818.5, 359);
  for (const a of [581, 647, 713, 779]) flat(g, 2, 64, '#EAF0F7', a, 0.95, 344);
}

// ---------------- Waiting pad ----------------
{
  const g = new THREE.Group(); scene.add(g);
  rboxAt(g, 184, 1, 80, C.concrete, 580, 0, 84, 0.4, 1);
  const c = document.createElement('canvas'); c.width = 520; c.height = 760;
  const x = c.getContext('2d'); x.fillStyle = '#FDF0D2'; x.fillRect(0, 0, 520, 760);
  x.strokeStyle = '#F7C766'; x.lineWidth = 50;
  for (let i = -760; i < 520; i += 100) { x.beginPath(); x.moveTo(i, 760); x.lineTo(i + 760, 0); x.stroke(); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16;
  for (const a of [520, 580, 640]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(52, 76), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    m.rotation.x = -Math.PI / 2; m.position.set(a, 1.05, 84); m.receiveShadow = true; g.add(m);
    rboxAt(g, 24, 3, 4, C.white, a, 1, 118, 1);
  }
  for (const a of [490, 550, 610, 670]) flat(g, 2, 80, C.white, a, 1.1, 84);
}

// ---------------- Lab (hero #2) ----------------
{
  const g = new THREE.Group(); scene.add(g);
  rboxAt(g, 116, 1.4, 80, C.labPave, 372, 0, 658, 4, 1);
  rboxAt(g, 56, 40, 56, C.white, 360, 1, 658, 8);
  rboxAt(g, 32, 27, 56, C.white, 408, 1, 658, 8);
  rboxAt(g, 57, 6, 57, C.purple, 360, 31, 658, 3);
  rboxAt(g, 33, 6, 57, C.purple, 408, 23, 658, 3);
  for (const [w, d, x, z, h] of [[56, 3, 360, 630.5, 3], [56, 3, 360, 685.5, 3], [3, 56, 332.5, 658, 3], [3, 56, 387.5, 658, 3]])
    rboxAt(g, w, h, d, C.white, x, 41, z, 1);
  for (const [w, d, x, z, h] of [[32, 3, 408, 631.5, 3], [32, 3, 408, 684.5, 3], [3, 56, 423.5, 658, 3]])
    rboxAt(g, w, h, d, C.white, x, 29, z, 1);
  const win = (w, h, x, y, z) => { rboxAt(g, w + 3, h + 3, 1.2, C.white, x, y - 1.5, z, 1.2); rboxAt(g, w, h, 1.6, C.lavGlass, x, y, z + 0.3, 1.2); };
  win(18, 14, 345, 12, 686.2); win(18, 14, 374, 12, 686.2); win(14, 12, 408, 9, 686.2);
  rboxAt(g, 1, 20, 16, C.rail, 424.5, 1, 650, 1.4);
  rboxAt(g, 1.4, 17, 13, C.white, 425, 2, 650, 1.2);
  rboxAt(g, 8, 3, 24, C.white, 428, 24.5, 650, 1.2);
  rboxAt(g, 1.4, 9, 14, C.lavGlass, 425, 12, 672, 1);
  rboxAt(g, 4, 1.5, 12, C.white, 426.5, 10.5, 672, 0.6);
  rboxAt(g, 10, 8, 8, C.white, 404, 1.4, 692, 2); rboxAt(g, 10.6, 2.4, 8.6, C.purple, 404, 9.2, 692, 1);
  const ped = cyl(10, 4, C.white, 40); ped.position.set(360, 45 + 2, 658); g.add(ped);
  const prof = [[0, 0], [6.5, 0], [7, 1], [6.6, 3], [2.6, 14], [2.4, 17.5], [3.5, 18], [3.5, 20], [2.6, 20]].map(([r, y]) => new THREE.Vector2(r, y));
  const fl = shade(new THREE.Mesh(new THREE.LatheGeometry(prof, 40), new THREE.MeshStandardMaterial({ color: C.purple, roughness: 0.35, side: THREE.DoubleSide })));
  fl.position.set(360, 49, 658); g.add(fl);
  contact(372, 662, 120, 80);
  P['LAB base'] = [378, 658, 0]; P['LAB flask'] = [360, 658, 49 + 20]; P['LAB pin'] = [360, 658, 49 + 20 + 32];
}

// ---------------- Props ----------------
const g2 = (x, y) => { const A = (y - 132) * 2, B = (x - 392) / 0.866; const a = (A + B) / 2, b = (A - B) / 2; return [a, b]; };
for (const [x, y] of [[96, 470], [330, 505], [402, 690], [1002, 565], [1180, 610], [1344, 590]]) {
  const [a, b] = g2(x, y); const t = new THREE.Group(); t.position.set(a, 0, b);
  const tr = cyl(1.5, 7, C.slate, 10); tr.position.y = 3.5; t.add(tr);
  const cr = shade(new THREE.Mesh(new THREE.SphereGeometry(6.5, 20, 14), mat(C.tree))); cr.position.y = 12; t.add(cr);
  scene.add(t); contact(a + 3, b, 18, 14);
}
for (const [a, b] of [[495, 425], [500, 560], [330, 706]]) {
  const t = new THREE.Group(); t.position.set(a, 0, b);
  const p = cyl(1.2, 30, C.slate, 10); p.position.y = 15; t.add(p);
  const h = shade(new THREE.Mesh(new THREE.SphereGeometry(3.2, 14, 10), mat(C.white))); h.position.y = 31; t.add(h);
  scene.add(t); contact(a + 2, b, 8, 6);
}
{
  const cn = shade(new THREE.Mesh(new THREE.ConeGeometry(3, 10, 20), mat(C.orange))); cn.position.set(495, 5, 668); scene.add(cn);
  rboxAt(scene, 8, 1.4, 8, C.orange, 495, 0, 668, 0.5);
}

renderer.render(scene, cam);

const out = { size: [W, H], points: {} };
for (const [n, p] of Object.entries(P)) out.points[n] = proj(...p);
window.__meta = out;

if (OUT) {
  const url = renderer.domElement.toDataURL('image/png');
  await fetch('/save-png?name=' + OUT + '.png', { method: 'POST', body: url });
  await fetch('/save-json?name=' + OUT + '.json', { method: 'POST', body: JSON.stringify(out) });
  document.title = 'done';
}
