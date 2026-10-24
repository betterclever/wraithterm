"""Deterministic studio plates for the fframes Phantom cut.
Run Blender --background --factory-startup --python studio/phantom.py -- --shot mark --frame 120.
The factory-startup process keeps existing interactive Blender documents untouched.
"""

import argparse, pathlib, sys
import bpy
from mathutils import Vector

ROOT = pathlib.Path(__file__).resolve().parent.parent
args = argparse.ArgumentParser()
args.add_argument("--shot", choices=["mark", "ribbon", "stack"], default="mark")
args.add_argument("--frame", type=int)
args.add_argument("--scale", type=int, default=100)
args.add_argument("--engine", choices=["cycles", "eevee"], default="cycles")
a = args.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
s = bpy.context.scene
s.render.engine = "CYCLES"
s.cycles.device = "GPU"
s.cycles.samples = 24
s.cycles.use_denoising = True
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"
prefs.get_devices()
for device in prefs.devices:
    device.use = device.type != "CPU"
if a.engine == "eevee":
    s.render.engine = "BLENDER_EEVEE"
s.render.resolution_x = 1920
s.render.resolution_y = 1080
s.render.resolution_percentage = a.scale
s.render.fps = 60
s.render.image_settings.file_format = "PNG"
s.render.image_settings.color_mode = "RGB"
s.render.film_transparent = False
s.render.use_motion_blur = True
s.render.motion_blur_shutter = 0.35
s.world.color = (0, 0, 0)
s.world.use_nodes = True
s.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
    0.002,
    0.001,
    0.001,
    1,
)
s.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.1
s.view_settings.view_transform = "AgX"
s.view_settings.look = "AgX - Medium High Contrast"
s.view_settings.exposure = 0.2


def material(name, color, metal=0.9, rough=0.19, emission=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    p.inputs["Coat Weight"].default_value = 0.35
    p.inputs["Coat Roughness"].default_value = 0.12
    if emission:
        p.inputs["Emission Color"].default_value = (*color, 1)
        p.inputs["Emission Strength"].default_value = emission
    return m


amber = material("Champagne anodized alloy", (0.76, 0.38, 0.12))
chrome = material("Pale champagne chrome", (0.86, 0.75, 0.62), 0.95, 0.16)
dark = material("Smoked graphite", (0.038, 0.026, 0.023), 0.8, 0.24)
lightmat = material("Signal", (1, 0.54, 0.22), 0, 0.15, 4)


def point(obj, target):
    obj.rotation_euler = (
        (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    )


def area(name, loc, power, size, color, target=(0, 0, 0), shape="DISK", size_y=None):
    d = bpy.data.lights.new(name, "AREA")
    d.energy = power
    d.shape = shape
    d.size = size
    d.color = color
    if size_y is not None:
        d.size_y = size_y
    o = bpy.data.objects.new(name, d)
    s.collection.objects.link(o)
    o.location = loc
    point(o, target)
    return o


area("Long softbox", (-3, -5, 7), 1800, 7, (1, 0.92, 0.83), shape="RECTANGLE", size_y=2)
area("Amber rim", (6, 1, 3), 2200, 6, (1, 0.44, 0.13), shape="RECTANGLE", size_y=1.2)
area(
    "White reflection",
    (1, -5, -3),
    1000,
    5,
    (1, 0.93, 0.86),
    shape="RECTANGLE",
    size_y=0.65,
)
area("Violet edge", (-6, 2, 1), 1600, 5, (0.45, 0.32, 1), shape="RECTANGLE", size_y=1)
area("Frontal fill", (0, -8, 4), 650, 9, (1, 0.76, 0.51))
camdata = bpy.data.cameras.new("Camera")
cam = bpy.data.objects.new("Camera", camdata)
s.collection.objects.link(cam)
s.camera = cam
camdata.lens = 50
camdata.clip_start = 0.02
camdata.clip_end = 200


def camera(frame, location, target, lens=50):
    cam.location = location
    point(cam, target)
    camdata.lens = lens
    cam.keyframe_insert(data_path="location", frame=frame)
    cam.keyframe_insert(data_path="rotation_euler", frame=frame)
    camdata.keyframe_insert(data_path="lens", frame=frame)


def key(obj, frame, loc=None, rot=None):
    if loc is not None:
        obj.location = loc
        obj.keyframe_insert(data_path="location", frame=frame)
    if rot is not None:
        obj.rotation_euler = rot
        obj.keyframe_insert(data_path="rotation_euler", frame=frame)


def bevel(obj, width=0.08, segments=5):
    m = obj.modifiers.new("Machined radii", "BEVEL")
    m.width = width
    m.segments = segments
    obj.modifiers.new("Weighted corner normals", "WEIGHTED_NORMAL")
    for p in obj.data.polygons:
        p.use_smooth = True


def cube(name, loc, scale, mat, radius=0.1):
    bpy.ops.mesh.primitive_cube_add(size=2, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    bevel(o, radius)
    return o


def curve(name, points, mat, radius=0.08):
    d = bpy.data.curves.new(name, "CURVE")
    d.dimensions = "3D"
    d.resolution_u = 24
    d.bevel_depth = radius
    d.bevel_resolution = 5
    spl = d.splines.new("BEZIER")
    spl.bezier_points.add(len(points) - 1)
    for p, v in zip(spl.bezier_points, points):
        p.co = v
        p.handle_left_type = "AUTO"
        p.handle_right_type = "AUTO"
    o = bpy.data.objects.new(name, d)
    s.collection.objects.link(o)
    d.materials.append(mat)
    return o


if a.shot == "mark":
    # Build one beveled mesh from the exact cell mask used by The Arrival.
    rows = (ROOT / "src/wordmark.txt").read_text().splitlines()
    verts = []
    faces = []
    ramp = "_.:-=+*#%@"
    for iy, row in enumerate(rows):
        for ix, ch in enumerate(row):
            level = ramp.index(ch)
            if level < 3:
                continue
            x = (ix - 51.5) * 0.12
            z = (12.5 - iy) * 0.12
            depth = 0.07 + 0.06 * level / 9
            base = len(verts)
            verts += [
                (x + dx * 0.050, -depth + dy * 0.08, z + dz * 0.050)
                for dx, dy, dz in [
                    (-1, -1, -1),
                    (1, -1, -1),
                    (1, 1, -1),
                    (-1, 1, -1),
                    (-1, -1, 1),
                    (1, -1, 1),
                    (1, 1, 1),
                    (-1, 1, 1),
                ]
            ]
            faces += [
                tuple(base + i for i in f)
                for f in [
                    (0, 3, 2, 1),
                    (4, 5, 6, 7),
                    (0, 1, 5, 4),
                    (1, 2, 6, 5),
                    (2, 3, 7, 6),
                    (3, 0, 4, 7),
                ]
            ]
    mesh = bpy.data.meshes.new("Wraith cell geometry")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    o = bpy.data.objects.new("WRAITH", mesh)
    s.collection.objects.link(o)
    o.data.materials.append(chrome)
    bevel(o, 0.012, 3)
    key(o, 1, rot=(0, 0, -0.07))
    key(o, 150, rot=(0, 0, 0))
    key(o, 240, rot=(0, 0, 0))
    camera(1, (-4, -1.4, 0.65), (-3.5, 0, 0), 44)
    camera(60, (-2.5, -3.1, 0.6), (-1.8, 0, 0), 46)
    camera(150, (0.6, -20, 1.1), (0, 0, 0), 48)
    camera(240, (0.1, -20.5, 0.3), (0, 0, 0), 48)
    s.frame_end = 240
elif a.shot == "ribbon":
    # Three long swept rails form one continuous S-curve, with emissive packets following it.
    pts = [
        (-8, 0, 1),
        (-4, 0, 1),
        (-1, 0, 1),
        (1, 0, -0.4),
        (4, 0, -0.4),
        (6, 0, 1.1),
        (10, 0, 1.1),
    ]
    for i in range(3):
        curve(
            "Data rail " + str(i),
            [(x, y + i * 0.24, z - i * 0.18) for x, y, z in pts],
            amber if i == 1 else chrome,
            0.055,
        )
    for i in range(9):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.085)
        o = bpy.context.object
        o.data.materials.append(lightmat)
        path = s.objects.get("Data rail " + str(i % 3))
        path.data.use_path = True
        follow = o.constraints.new("FOLLOW_PATH")
        follow.target = path
        follow.use_fixed_location = True
        follow.use_curve_follow = False
        for f in range(1, 241):
            follow.offset_factor = (f / 360 + i * 0.11) % 1
            follow.keyframe_insert(data_path="offset_factor", frame=f)
    camera(1, (-3, -4.5, 3), (-1, 0, 0.7), 47)
    camera(120, (1, -6, 3.2), (1, 0, 0.25), 48)
    camera(240, (5, -7, 1.4), (4, 0, 0.3), 50)
    s.frame_end = 240
else:
    for i in range(5):
        o = cube(
            "Retained GPU layer " + str(i),
            (0, i * 0.3, 0),
            (2.6, 0.09, 1.65),
            amber if i % 2 == 0 else chrome,
            0.22,
        )
        key(o, 1, (i * 0.12, i * 0.6, -i * 0.09), (0.04 * i, 0, -0.035 * i))
        key(o, 140, (i * 0.055, i * 0.28, -i * 0.05), (0, 0, 0))
        key(o, 216, (i * 0.055, i * 0.28, -i * 0.05), (0, 0, 0))
        # Small precise milled slots give the slabs recognizable terminal structure.
        if i == 0:
            for j in range(11):
                bar = cube(
                    "Terminal row " + str(j),
                    (-0.25, -0.112, 1.15 - j * 0.21),
                    (1.85 - (j % 4) * 0.25, 0.012, 0.021),
                    dark,
                    0.016,
                )
    camera(1, (6, -7, 4.2), (0, 0, 0), 53)
    camera(140, (3, -9, 2.9), (0, 0, 0), 52)
    camera(216, (1.2, -10, 0.8), (0, 0, 0), 52)
    s.frame_end = 216

# Blender's auto-clamped handles avoid acceleration discontinuities at each pose.
for ob in [cam, camdata] + list(s.objects):
    if ob.animation_data and ob.animation_data.action:
        action = ob.animation_data.action
        for layer in action.layers:
            for strip in layer.strips:
                for slot in action.slots:
                    bag = strip.channelbag(slot)
                    if bag:
                        for fc in bag.fcurves:
                            for k in fc.keyframe_points:
                                k.interpolation = "BEZIER"
                                k.handle_left_type = "AUTO_CLAMPED"
                                k.handle_right_type = "AUTO_CLAMPED"
folder = ROOT / ".cache/phantom/studio" / a.shot
folder.mkdir(parents=True, exist_ok=True)
s.render.filepath = str(folder / "frame-")
if a.frame:
    s.frame_set(a.frame)
    s.render.filepath = str(folder / f"proof-{a.frame:04d}.png")
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.wm.save_as_mainfile(filepath=str(folder / "scene.blend"))
    bpy.ops.render.render(animation=True)
