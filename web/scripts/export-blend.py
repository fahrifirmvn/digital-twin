"""Ubah design3d.blend (satu pabrik utuh) menjadi satu GLB per jenis modul untuk Twin 3D.

Pakai (perlu modul `bpy`, mis. `uv venv --python 3.11 /tmp/bpyenv && uv pip install --python /tmp/bpyenv/bin/python bpy`):

    /tmp/bpyenv/bin/python web/scripts/export-blend.py design3d.blend web/public/models

Hasil: <jenis>.glb + manifest.json. Konvensi node (dibaca resources/js/twin/kit/models.js):
  status      mesh tunggal bermaterial sendiri, warnanya diganti per status (cincin di truk dan tangki)
  level       mesh tunggal setinggi penuh, origin di dasar, di-skala 0..1 menurut isi (jendela level tangki)
  asep        mesh tunggal tangki aseptik (hanya STE), asep_level jendela levelnya

Pemetaan objek Blender -> jenis modul ada di KINDS. Pipa antar-modul (nama memuat " to "), kurva
(cabang pipa panjang) dan baut/mur kecil dibuang supaya ukuran modul tidak melebar. Jenis tanpa objek di .blend
(mis. SEP) tidak diekspor, sehingga tetap memakai modul prosedural.
"""
import json
import math
import os
import re
import sys

import bpy
import bmesh  # noqa: E402  (hanya ada setelah bpy diimpor)
from mathutils import Matrix, Vector

SRC = sys.argv[1] if len(sys.argv) > 1 else "design3d.blend"
OUT = sys.argv[2] if len(sys.argv) > 2 else "web/public/models"

# jenis -> pola nama objek utama; `asep` = pola tangki aseptik yang ditempel di sisi sterilizer.
KINDS = {
    "truck": {"re": r"^Truck T-1( |$)", "rotationY": 0},
    "silo": {"re": r"^STORAGE TANK ST-01( |$)", "rotationY": -90},
    "DEG": {"re": r"^Filtration "},
    "THM": {"re": r"^Thermizer "},
    "STE": {"re": r"^Sterilization ", "asep": r"^ASEPTIC TANK AT-01( |$)"},
    "LINE": {"re": r"^FL-1A( |$)"},
}
GAP = 0.7  # jarak sterilizer ke tangki aseptik (m)


SMALL = re.compile(r"Bolt|Nut|Screw|Washer|Rivet|Gasket|Cable Gland|Stud")


def keep(o):
    return o.type == "MESH" and " to " not in o.name and not SMALL.search(o.name)


def pick(rx):
    return [o for o in bpy.data.objects if re.search(rx, o.name) and keep(o)]


def bbox(objs):
    mn, mx = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    return mn, mx


def evaluated_copy(o, offset, name):
    """Salinan mesh ter-evaluasi (modifier diterapkan) di koordinat dunia + offset."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    me.transform(o.matrix_world)
    me.transform(Matrix.Translation(offset))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def join(objs, name):
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def material(name, rgba):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = 0.5
    return m


def cylinder(name, centre, radius, length, axis, mat):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=radius, radius2=radius, depth=length)
    if axis == "x":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "Y"))
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = centre
    ob.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def box(name, mn, mx, mat):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.5))  # origin di dasar
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    ob.scale = (mx - mn)
    ob.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def sight_level(name, glass, depth, mat):
    """Kotak setinggi jendela level (origin di dasar) sedikit di depan kaca, untuk di-skala 0..1."""
    mn, mx = bbox([glass])
    cx = mx.x + depth / 2
    return box(name, Vector((cx - depth / 2, mn.y - 0.02, mn.z)), Vector((cx + depth / 2, mx.y + 0.02, mx.z)), mat)


def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False,
                              export_yup=True, export_cameras=False, export_lights=False)


def build(kind, cfg):
    srcs = pick(cfg["re"])
    if not srcs:
        print(f"{kind}: tidak ada objek, dilewati")
        return None
    mn, mx = bbox(srcs)
    centre = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, 0))
    offset = -centre  # pusatkan di x/y
    special = []
    parts = []

    if kind == "STE":
        a_srcs = pick(cfg["asep"])
        a_mn, a_mx = bbox(a_srcs)
        shell_like = [o for o in a_srcs if re.search(r"(Shell|Top Dome|Bottom Dome)$", o.name)]
        radius = (a_mx.x - a_mn.x) / 2
        a_centre = Vector(((a_mn.x + a_mx.x) / 2, (a_mn.y + a_mx.y) / 2, 0))
        target = Vector((mx.x + GAP + radius, (mn.y + mx.y) / 2, 0))
        a_off = offset + (target - a_centre)
        asep = join([evaluated_copy(o, a_off, "asep") for o in shell_like], "asep")
        rest = [o for o in a_srcs if o not in shell_like]
        parts += [evaluated_copy(o, a_off, o.name) for o in rest]
        special.append(asep)
        glass = next((o for o in a_srcs if o.name.endswith("Level Sight Glass")), None)
        if glass:
            lv = sight_level("asep_level", glass, 0.06, material("Milk Level", (0.96, 0.95, 0.9, 1)))
            lv.location += a_off
            special.append(lv)

    parts += [evaluated_copy(o, offset, o.name) for o in srcs]
    body = join(parts, "body")

    if kind in ("silo", "truck"):
        shell = next((o for o in srcs if re.search(r"(Shell|Tanker Body)$", o.name)), None)
        smn, smx = bbox([shell])
        smat = material("Status Band", (0.55, 0.75, 0.95, 1))
        if kind == "silo":
            r = (smx.x - smn.x) / 2 + 0.02
            c = Vector(((smn.x + smx.x) / 2, (smn.y + smx.y) / 2, smx.z - 0.4)) + offset
            special.append(cylinder("status", c, r, 0.35, "z", smat))
        else:
            r = (smx.y - smn.y) / 2 + 0.02
            c = Vector(((smn.x + smx.x) / 2, (smn.y + smx.y) / 2, (smn.z + smx.z) / 2)) + offset
            special.append(cylinder("status", c, r, 0.5, "x", smat))
        glass = next((o for o in srcs if o.name.endswith("Level Sight Glass")), None)
        if glass:
            lv = sight_level("level", glass, 0.06, material("Milk Level", (0.96, 0.95, 0.9, 1)))
            lv.location += offset
            special.append(lv)

    return [body] + special


def main():
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(SRC))
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for kind, cfg in KINDS.items():
        made = build(kind, cfg)
        if not made:
            continue
        export(made, os.path.join(OUT, f"{kind}.glb"))
        entry = {"file": f"{kind}.glb"}
        if cfg.get("rotationY"):
            entry["rotationY"] = math.radians(cfg["rotationY"])
        manifest[kind] = entry
        print(f"{kind}: {sum(len(o.data.polygons) for o in made)} poligon")
        for o in made:
            bpy.data.objects.remove(o, do_unlink=True)
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
