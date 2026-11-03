"""Ubah dairy_processing_equipment.blend (pabrik utuh, versi final) menjadi satu plant.glb + plant.json
untuk mode "Pabrik realistis" Twin 3D.

Pakai (perlu modul `bpy`, lihat export-blend.py):

    /tmp/bpyenv/bin/python web/scripts/export-plant.py \
        3d/Semester3/source/dairy_processing_equipment.blend web/public/models

Struktur GLB (nama dibaca resources/js/twin langsung):
  ST-01..15, SFP-01..06, AT-01..05, FL-1A..5B   Empty per peralatan (sembunyikan satu node = peralatan itu hilang).
      <id>_body     seluruh mesh peralatan digabung (satu primitif per material)
      <id>_level    kotak setinggi jendela level (origin di dasar), di-skala 0..1 menurut isi (tangki)
      <id>_status   cincin tipis di bahu tangki, warnanya diganti menurut status (tangki)
      <id>_beacon_amber|green|red   lampu menara filling line, material sendiri
  PIPE_<n>       pipa susu (satu node per pipa, anak dari grup pemiliknya) agar bisa dibuat transparan saat dialiri susu;
                 jalurnya (titik, radius, pemilik) ditulis ke plant.json `pipes`
  common         semua yang lain (truk tidak ikut): filtrasi, sterilizer, pompa, pipa, panel, lantai zona
  ANCHOR_*       empty asli dari .blend (level, katup, aliran, ...)
Truk tidak diekspor di sini: posisi dan arah bay unloading ada di plant.json (`bays`), model truk pakai truck.glb.
Baut, mur, dan sejenisnya dibuang (tidak terlihat pada skala pabrik).
"""
import importlib.util
import time
import json
import os
import re
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("export_blend", os.path.join(HERE, "export-blend.py"))
eb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eb)

SRC = sys.argv[1] if len(sys.argv) > 1 else "3d/Semester3/source/dairy_processing_equipment.blend"
OUT = sys.argv[2] if len(sys.argv) > 2 else "web/public/models"

SMALL = re.compile(r"Bolt|Nut|Screw|Washer|Rivet|Stud|Cable Gland")
EQUIPMENT = [
    (re.compile(r"^STORAGE TANK (ST-\d+) "), "ST"),
    (re.compile(r"^SFP STORAGE (SFP-\d+) "), "SFP"),
    (re.compile(r"^ASEPTIC TANK (AT-\d+) "), "AT"),
    (re.compile(r"^Aseptic (AT-\d+) to Filling Cell"), "AT"),
    (re.compile(r"^FILLING CELL (AT-\d+) "), "AT"),
    (re.compile(r"^(?:ASEPTIC|CELL) (AT-\d+)"), "AT"),  # label teks
    (re.compile(r"^(FL-\d[AB])( |$)"), "FL"),
]
TRUCK = re.compile(r"^Truck (T-\d+) ")
# Pipa yang dialiri susu; kabel, impulse tube, uap, dan gagang tutup bukan jalur susu.
MILK_PIPE = re.compile(
    r"(Feed Line(\.\d+)?|Feed Riser|Unloading Manifold|Unloading to Storage Header|Outlet Line(\.\d+)?|Outlet Collector|"
    r"Farm to Filtration|Filtration Inlet Pipe|Filtration Outlet Pipe|Filtration to SFP|SFP Inlet Header|SFP Outlet Riser|"
    r"SFP to Sterilizer|Sterilization Process Line|Sterilizer to Aseptic|Aseptic Inlet Header|Feed Branch|Outlet Branch|"
    r"Aseptic AT-\d+ to Filling Cell|Branch [AB]|Product Inlet Pipe)$"
)
BEACON = re.compile(r"^(FL-\d[AB]) Beacon (Amber|Green|Red)$")
TANK_KINDS = ("ST", "SFP", "AT")
SHELL = {"ST": "STORAGE TANK {} Shell", "SFP": "SFP STORAGE {} Shell", "AT": "ASEPTIC TANK {} Shell"}
GLASS = {"ST": "STORAGE TANK {} Level Sight Glass", "SFP": "SFP STORAGE {} Level Sight Glass",
         "AT": "ASEPTIC TANK {} Level Sight Glass"}


def classify(name):
    for rx, kind in EQUIPMENT:
        m = rx.match(name)
        if m:
            return kind, m.group(1)
    return "common", "common"


def to_gltf(v):
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


def triangles(ob):
    return sum(max(1, len(p.vertices) - 2) for p in ob.data.polygons)


def evaluate_all(objs, offset):
    """Mesh ter-evaluasi (modifier diterapkan) di koordinat dunia + offset; satu depsgraph untuk semua agar cepat."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = {}
    for o in objs:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.transform(o.matrix_world)
        me.transform(Matrix.Translation(offset))
        out[o.as_pointer()] = me
    return out


def spawn(me, name):
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def truck_bays(objs, offset):
    """Posisi dan arah (menuju kabin) tiap truk di bay unloading, dalam koordinat glTF setelah offset."""
    bays = []
    ids = sorted({TRUCK.match(o.name).group(1) for o in objs if TRUCK.match(o.name)})
    for tid in ids:
        parts = [o for o in objs if o.name.startswith(f"Truck {tid} ")]
        mn, mx = eb.bbox(parts)
        body = [o for o in parts if o.name.endswith("Milk Tanker Body")]
        cab = [o for o in parts if o.name.endswith("Cabin")]
        b_mn, b_mx = eb.bbox(body)
        c_mn, c_mx = eb.bbox(cab)
        centre = (mn + mx) / 2
        head = ((c_mn + c_mx) / 2) - ((b_mn + b_mx) / 2)
        axis = Vector((head.x, head.y, 0))
        axis.normalize()
        size = mx - mn
        along = abs(axis.x) * size.x + abs(axis.y) * size.y
        across = abs(axis.y) * size.x + abs(axis.x) * size.y
        bays.append({
            "id": tid,
            "at": to_gltf(Vector((centre.x, centre.y, 0)) + offset),
            "dir": [round(axis.x, 4), round(-axis.y, 4)],
            "length": round(along, 3),
            "width": round(across, 3),
        })
    return bays


T0 = time.time()


def tick(msg):
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


def main():
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(SRC))
    os.makedirs(OUT, exist_ok=True)
    O = list(bpy.data.objects)
    geo = [o for o in O if o.type in ("MESH", "CURVE", "FONT")]
    plain = [o for o in geo if not SMALL.search(o.name)]
    solid = [o for o in plain if not TRUCK.match(o.name)]

    mn, mx = eb.bbox([o for o in geo if o.type == "MESH"])
    offset = Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, 0))
    bays = truck_bays(plain, offset)
    tick('bay')
    meshes = evaluate_all(solid, offset)
    tick('evaluasi mesh')

    buckets = {}
    beacons = []
    pipes = []
    for o in solid:
        m = BEACON.match(o.name)
        if m:
            beacons.append((m.group(1), m.group(2).lower(), o))
            continue
        if o.type == "CURVE" and MILK_PIPE.search(o.name):
            pipes.append(o)
            continue
        kind, gid = classify(o.name)
        buckets.setdefault((kind, gid), []).append(o)

    made = []  # semua objek baru yang diekspor
    roots = {}
    milk = eb.material("Milk Level", (0.96, 0.95, 0.9, 1))
    band = eb.material("Status Band", (0.55, 0.75, 0.95, 1))
    stats = {"tris": 0}
    ids = {"ST": [], "SFP": [], "AT": [], "FL": []}

    def empty(name):
        stale = bpy.data.objects.get(name)  # objek sumber bernama sama (mis. label teks) agar nama GLB tidak berakhiran .001
        if stale:
            stale.name = f"_src_{name}"
        e = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(e)
        made.append(e)
        roots[name] = e
        return e

    def child(ob, parent):
        ob.parent = parent
        made.append(ob)

    for (kind, gid), srcs in sorted(buckets.items(), key=lambda kv: kv[0][1]):
        root = empty(gid)
        tick(gid)
        body = eb.join([spawn(meshes[o.as_pointer()], o.name) for o in srcs], f"{gid}_body")
        child(body, root)
        stats["tris"] += triangles(body)
        if kind in ids:
            ids[kind].append(gid)
        if kind in TANK_KINDS:
            shell = bpy.data.objects.get(SHELL[kind].format(gid))
            glass = bpy.data.objects.get(GLASS[kind].format(gid))
            if glass:
                lv = eb.sight_level(f"{gid}_level", glass, 0.06, milk)
                lv.location += offset
                child(lv, root)
            if shell:
                smn, smx = eb.bbox([shell])
                r = (smx.x - smn.x) / 2 + 0.02
                c = Vector(((smn.x + smx.x) / 2, (smn.y + smx.y) / 2, smx.z - 0.4)) + offset
                child(eb.cylinder(f"{gid}_status", c, r, 0.3, "z", band), root)

    pipe_meta = []
    for k, o in enumerate(sorted(pipes, key=lambda p: p.name)):
        _, gid = classify(o.name)
        ob = spawn(meshes[o.as_pointer()], f"PIPE_{k}")
        child(ob, roots[gid])
        stats["tris"] += triangles(ob)
        spline = o.data.splines[0]
        pts = [to_gltf(o.matrix_world @ Vector(p.co[:3]) + offset) for p in spline.points]
        scale = sum(o.matrix_world.to_scale()) / 3
        pipe_meta.append({"id": f"PIPE_{k}", "name": o.name, "owner": gid, "r": round(o.data.bevel_depth * scale, 4), "pts": pts})

    for bay in bays:
        line = bpy.data.objects.get(f"Truck {bay['id']} Line")
        if line:
            p = line.data.splines[0].points[-1]
            bay["join"] = to_gltf(line.matrix_world @ Vector(p.co[:3]) + offset)

    for fl, colour, o in beacons:
        root = roots[fl]
        ob = spawn(meshes[o.as_pointer()], f"{fl}_beacon_{colour}")
        child(ob, root)
        stats["tris"] += triangles(ob)

    anchors = [o for o in O if o.type == "EMPTY" and o.name.startswith("ANCHOR_")]
    for a in anchors:
        a.location += offset
        made.append(a)

    tick('ekspor')
    path = os.path.join(OUT, "plant.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for o in made:
        o.select_set(True)
    bpy.context.view_layer.objects.active = made[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False,
                              export_yup=True, export_cameras=False, export_lights=False, export_extras=True,
                              export_texcoords=False)

    lo = to_gltf(mn + offset)
    hi = to_gltf(mx + offset)
    meta = {
        "source": os.path.basename(SRC),
        "bounds": {"min": [min(a, b) for a, b in zip(lo, hi)], "max": [max(a, b) for a, b in zip(lo, hi)]},
        "ST": ids["ST"], "SFP": ids["SFP"], "AT": ids["AT"], "FL": ids["FL"],
        "bays": bays,
        "pipes": pipe_meta,
        "triangles": stats["tris"],
    }
    with open(os.path.join(OUT, "plant.json"), "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    print(f"plant.glb: {stats['tris']} segitiga, {os.path.getsize(path) / 1e6:.1f} MB, "
          f"{len(ids['ST'])} ST / {len(ids['SFP'])} SFP / {len(ids['AT'])} AT / {len(ids['FL'])} FL, {len(bays)} bay")


main()
