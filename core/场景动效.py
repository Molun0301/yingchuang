"""按材质、骨骼和发射器的类型转换场景动效。"""

from io import BytesIO
from itertools import chain
import json
import math
from pathlib import Path, PurePosixPath
import random
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from 骨骼动画 import bilinear, decode_rig, render_cycle


ASSET_ERRORS = (ValueError, KeyError, IndexError, TypeError, OSError, struct.error)
WARP_EFFECTS = {"waterripple", "waterwaves", "foliagesway", "shake", "iris", "waterflow", "cloudmotion", "pulse"}
ANIMATION_PIXEL_LIMIT = 48_000_000
PARTICLE_LIMIT = 72


def as_albedo(image, texture_format):
    # 原着色器的颜色采样约定。方向图和遮罩仍需保留原始通道。
    if texture_format == 8:
        red, green, _, _ = image.split()
        return Image.merge("RGBA", (red, red, red, green))
    if texture_format == 9:
        result = Image.new("RGBA", image.size, "white")
        result.putalpha(image.getchannel("R"))
        return result
    return image


class SceneAssets:
    def __init__(self, package, stage, decode_texture, fast=False):
        self.package = package
        self.stage = stage
        self.decode_texture = decode_texture
        self.fast = fast
        self.textures = {}
        self.saved = {}
        self.animated_pixels = 0
        libraries = [p for p in package.path.parents if p.name.lower() == "steamapps"]
        libraries.append(Path.home() / ".local/share/Steam/steamapps")
        self.engine_roots = [p / "common/wallpaper_engine/assets" for p in libraries]
        self.engine_roots = list(getattr(package, "engine_roots", [])) + self.engine_roots

    def builtin(self, path):
        parts = PurePosixPath(path.replace("\\", "/"))
        if parts.is_absolute() or ".." in parts.parts or ":" in path:
            raise ValueError("引擎内置资源路径无效")
        for root in self.engine_roots:
            file = (root / parts).resolve()
            if file.is_relative_to(root.resolve()) and file.is_file() and file.stat().st_size <= 128*1024*1024:
                return file.read_bytes()
        return None

    def read(self, path):
        if self.package.has(path):
            return self.package.read(path)
        builtin = self.builtin(path)
        if builtin is None:
            raise ValueError("缺少资源 " + path)
        return builtin

    def json(self, path):
        data = self.read(path)
        if len(data) > 8*1024*1024:
            raise ValueError("资源描述过大")
        return json.loads(data.decode("utf-8-sig"))

    def texture_bytes(self, name):
        if not isinstance(name, str) or not name:
            raise ValueError("图层没有纹理路径")
        name = name.replace("\\", "/")
        path = name if name.startswith("materials/") else "materials/" + name
        if not path.lower().endswith((".tex", ".png", ".jpg", ".jpeg", ".webp")):
            path += ".tex"
        if path in self.textures:
            return self.textures[path]
        if self.package.has(path):
            data = self.package.read(path)
        else:
            data = self.builtin(path)
        self.textures[path] = data
        return data

    def is_video(self, name):
        data = self.texture_bytes(name)
        return bool(data and len(data)>=26 and data.startswith(b"TEXV0005\0TEXI0001\0")
                    and struct.unpack_from("<I",data,22)[0]&32)

    def is_atlas(self, name):
        data = self.texture_bytes(name)
        return bool(data and len(data) >= 26 and data.startswith(b"TEXV0005\0TEXI0001\0")
                    and struct.unpack_from("<I", data, 22)[0] & 4)

    def texture(self, name, *, albedo=False):
        data = self.texture_bytes(name)
        if data is None:
            raise ValueError("原工程缺少纹理 " + name)
        if data.startswith(b"TEXV"):
            image = self.decode_texture(data)
            return as_albedo(image, struct.unpack_from("<I", data, 18)[0]) if albedo else image
        with Image.open(BytesIO(data)) as image:
            if image.width * image.height > 32*1024*1024:
                raise ValueError("图像纹理过大")
            return image.convert("RGBA")

    def write(self, name, image, use_webp=True, *, lossless=False):
        if self.fast:use_webp=False
        file = "assets/" + name + (".webp" if use_webp else ".png")
        if file not in self.saved:
            path = self.stage / file
            if use_webp:
                # 保留透明度，按背屏尺寸压缩以减少逐帧解码负担。
                image.save(path, quality=89, method=4 if not lossless else 2, exact=False, lossless=lossless)
            else:
                image.save(path, optimize=not self.fast, compress_level=1 if self.fast else 6)
            self.saved[file] = [image.width, image.height]
        return file

    def sequence(self, name, frames, period, *, lossless=False):
        files, pixels = [], 0
        try:
            for i, image in enumerate(frames):
                pixels += image.width * image.height
                if self.animated_pixels + pixels > ANIMATION_PIXEL_LIMIT:
                    raise ValueError("动画资源达到背屏纹理预算")
                files.append(self.write(f"{name}_{i}", image, lossless=lossless))
            if len(files) < 2:
                raise ValueError("动画缺少有效帧")
        except Exception:
            for file in files:
                (self.stage / file).unlink(missing_ok=True)
                self.saved.pop(file, None)
            raise
        self.animated_pixels += pixels
        return {"frames": files, "period": max(len(files), int(period))}


def property_default(value, properties):
    if not isinstance(value, dict):
        return value
    user = value.get("user")
    setting = properties.get(user) if isinstance(user, str) else None
    if isinstance(setting, dict) and "value" in setting:
        return setting["value"]
    return value.get("value")


def effects_for(obj, properties):
    """提取已启用特效的实例参数，不运行源工程脚本。"""
    result = []
    for effect in obj.get("effects", []):
        path = effect.get("file", "").replace("\\", "/")
        enabled = property_default(effect.get("visible", True), properties)
        if not enabled or not path:
            continue
        name = PurePosixPath(path).parent.name.lower() or PurePosixPath(path).stem.lower()
        passes = effect.get("passes") or [{}]
        for entry in passes:
            opts = {}
            for key, val in (entry.get("constantshadervalues") or {}).items():
                val = property_default(val, properties)
                if val is not None:
                    opts[key.lower()] = val
            result.append((name, {"values": opts, "textures": entry.get("textures") or [], "combos": entry.get("combos") or {}}))
    return result


def finish_frame(image, layer, grade=(0, 0)):
    image = ImageOps.flip(image) if layer.get("flip_y") else image
    if grade != (0, 0):
        image = grade_pixels(image, *grade)
    opacity = layer.get("opacity", 1)
    tint = layer.get("color", [1, 1, 1])
    if opacity != 1 or tint != [1, 1, 1]:
        factors = [*tint, opacity]
        table = [min(255, max(0, round(i*f))) for f in factors for i in range(256)]
        image = image.point(table)
    if str(layer.get("blend", "")).lower() in {"additive", "add", "additivealpha"}:
        pixels = np.array(image, dtype=np.float32)
        light = pixels[..., :3].max(axis=2, keepdims=True)
        pixels[..., :3] *= 255/np.maximum(1, light)
        pixels[..., 3:] *= light/255
        image = Image.fromarray(np.rint(pixels).astype(np.uint8))
    return image


def numbers(raw, default):
    return vector_values(raw, default)[:len(default)]


def random_vector(rng, low, high, defaults):
    lo, hi = numbers(low, defaults), numbers(high, defaults)
    if len(lo) != len(defaults) or len(hi) != len(defaults):
        raise ValueError("粒子坐标维数不支持")
    return np.array([rng.uniform(a,b) for a,b in zip(lo,hi)])


def sample_scalar(rng, setting, default, limit):
    lo = float(setting.get("min", setting.get("max", default)))
    hi = float(setting.get("max", lo))
    if not math.isfinite(lo) or not math.isfinite(hi):
        raise ValueError("粒子参数无效")
    return min(limit, max(0, rng.uniform(lo, hi)))


def sprite_assets(assets, texture, material, name, descriptor, color):
    style = {"blend": material.get("blending", "normal"), "color": color}
    if assets.is_atlas(texture):
        frames = atlas_frames(assets, texture, first_only=assets.fast)
        if len(frames) > 1:
            # 扑翼、发光、雾等共用贴图帧读取器。
            raw_speed = descriptor.get("sequencemultiplier")
            speed = float(20 if raw_speed is None else raw_speed)
            period = max(400, min(6000, 1000*len(frames)/max(1, speed)))
            paths = assets.sequence(name, (finish_frame(im, style) for im in frames), period)
            return paths["frames"][0], paths, frames[0].height/frames[0].width
        sprite = frames[0]
    else:
        sprite = assets.texture(texture, albedo=True)
        sprite.thumbnail((192,192), Image.Resampling.LANCZOS)
    return assets.write(name, finish_frame(sprite, style)), None, sprite.height/sprite.width


def particle_spawn(rng, emitter, width):
    directions = np.array(numbers(emitter.get("directions"), [1, 1, 1])[:2])
    if emitter["name"] == "boxrandom":
        maximum = numbers(emitter.get("distancemax"), [0, 0, 0])
        # 默认发射盒围绕发射器中心展开。
        minimum = emitter.get("distancemin", [-abs(value) for value in maximum])
        return random_vector(rng, minimum, maximum, [0, 0, 0])[:2] * directions
    maximum = emitter.get("distancemax", 0)
    maximum = min(4*width, max(0, float(maximum))) if isinstance(maximum, (int, float)) else 0
    minimum = emitter.get("distancemin", 0)
    minimum = min(maximum, max(0, float(minimum))) if isinstance(minimum, (int, float)) else 0
    angle = rng.uniform(0, math.tau)
    radius = math.sqrt(rng.uniform(minimum**2, maximum**2))
    offset = np.array([math.cos(angle), math.sin(angle)]) * radius
    sign = np.array(numbers(emitter.get("sign"), [0, 0, 0])[:2])
    return np.where(sign == 0, offset, np.abs(offset) * np.sign(sign)) * directions


def prewarm_track(keys, elapsed):
    # 平移循环的起点，保留在发射器预热时间已经出现在画面中的粒子。
    track = sorted({row[0]: tuple(row[1:]) for row in keys}.items())
    period = track[-1][0]
    elapsed %= period
    if not elapsed:
        return [(time, *values) for time, values in track]
    for (before, left), (after, right) in zip(track, track[1:]):
        if before <= elapsed < after:
            weight = (elapsed-before)/(after-before)
            start = tuple(a+(b-a)*weight for a,b in zip(left,right))
            break
    shifted = {(time-elapsed) % period: values for time,values in track[:-1]}
    shifted[period-elapsed-1] = track[-1][1]
    shifted[0] = shifted[period] = start
    return [(time, *values) for time,values in sorted(shifted.items())]


def sprite_tracks(assets, obj, state, sw, sh, name, limit, properties):
    descriptor = assets.json(obj["particle"])
    emitters = descriptor.get("emitter") or []
    if not emitters or not isinstance(emitters[0], dict):
        raise ValueError("粒子发射器缺少数据")
    renderer = (descriptor.get("renderer") or [{}])[0].get("name", "sprite")
    if renderer not in {"sprite", "spritetrail"}:
        raise ValueError(f"粒子渲染器 {renderer} 暂未支持")
    emitter = emitters[0]
    if emitter.get("name") not in {"boxrandom","sphererandom","conerandom","instantaneous","immediaterandom"}:
        raise ValueError(f"粒子发射器 {emitter.get('name')} 暂未支持")
    material = assets.json(descriptor["material"])["passes"][0]
    texture = material["textures"][0]
    initial = {setting.get("name"): setting for setting in descriptor.get("initializer", [])}
    operators = {setting.get("name"): setting for setting in descriptor.get("operator", [])}
    override = {key: property_default(value, properties) for key,value in (obj.get("instanceoverride") or {}).items()}
    override = {key: value for key,value in override.items() if value is not None}
    rng = random.Random(str(obj["id"]) + ":" + texture)
    a,b,c,d,origin_x,origin_y = state["matrix"]
    plane = np.array([[a,b],[c,d]])
    scale_x, scale_y = math.hypot(a,c), math.hypot(b,d)
    factor = max(.01, math.sqrt(abs(a*d-b*c)))
    origin = np.array(numbers(emitter.get("origin"), [0,0,0])[:2])
    movement = operators.get("movement", {})
    gravity = np.array(numbers(movement.get("gravity"), [0,0,0])[:2])
    drag = min(5, max(0,float(movement.get("drag", 0))))
    lifetime = initial.get("lifetimerandom", {})
    life_min = float(lifetime.get("min", lifetime.get("max", 5)))
    life_max = float(lifetime.get("max", life_min))
    live_capacity = float(descriptor.get("maxcount", 12)) * float(override.get("count", 1))
    rate = emitter.get("rate")
    if rate is not None:
        average_life = (life_min+life_max)*.5 * float(override.get("lifetime", 1))
        per_second = max(0, float(rate) * float(override.get("rate", 1)))
        live_capacity = min(live_capacity, average_life * per_second + float(emitter.get("instantaneous", 0)))
    count = min(limit, max(0, math.ceil(live_capacity)))
    if not count:
        return []
    color_range = initial.get("colorrandom", {})
    low = np.array(numbers(color_range.get("min"), [255,255,255]))
    high = np.array(numbers(color_range.get("max"), low))
    color = np.array(numbers(override.get("colorn"), (low+high)/510))
    if color.max() > 1:
        color /= 255
    overbright = float((material.get("constantshadervalues") or {}).get("ui_editor_properties_overbright", 1))
    tint = np.clip(color * np.array(state["color"]) * overbright, 0, 1).tolist()
    wave = operators.get("oscillateposition", {})
    fade_settings = operators.get("alphafade", {})
    fade_in = min(.94, max(.01, float(fade_settings.get("fadeintime", .1))))
    fade_out = min(.99, max(fade_in, float(fade_settings.get("fadeouttime", .9))))
    prewarm = max(0, round(float(descriptor.get("starttime", 0) or 0)*1000))
    bounds = [min(sw, sh)*.16, min(sw, sh)*.16]
    motion = min(2,max(.2,1+state["depth"]*.45))
    layers = []
    for _ in range(count*9):
        if len(layers) == count:
            break
        life = sample_scalar(rng, initial.get("lifetimerandom",{}), 5, 35)
        life = max(.35, min(35,life*float(override.get("lifetime",1))))
        size = sample_scalar(rng, initial.get("sizerandom",{}), 36, 2500)
        size = max(1, min(sw*1.7, size*factor*float(override.get("size",1))))
        opacity = sample_scalar(rng, initial.get("alpharandom",{}), 1, 1)
        opacity = min(255, round(255*opacity*state["alpha"]*max(0,float(override.get("alpha",1)))))
        if opacity <= 0:
            continue
        position = origin + particle_spawn(rng, emitter, sw)
        velocity = random_vector(rng, initial.get("velocityrandom",{}).get("min"),
                                 initial.get("velocityrandom",{}).get("max"), [0,0,0])[:2]
        velocity *= float(override.get("speed",1))
        if not velocity.any() and isinstance(emitter.get("speedmax"), (int,float)):
            velocity[0] = .5*float(emitter["speedmax"])
        # 在有限采样点上重建运动，超出画幅的轨迹不占手机端图层。
        frequency = rng.uniform(float(wave.get("frequencymin", .8)), float(wave.get("frequencymax", 1))) if wave else 0
        amplitude = rng.uniform(float(wave.get("scalemin", 0)), float(wave.get("scalemax", 0))) if wave else 0
        phase = rng.uniform(float(wave.get("phasemin", 0)), float(wave.get("phasemax", 1))) * math.tau if wave else 0
        oscillation = np.array(numbers(wave.get("mask"), [1, 1, 1])[:2]) * amplitude
        samples, visible = [], []
        step = life/30
        for i in range(31):
            swing = (math.sin(phase+i*step*frequency*math.tau)-math.sin(phase)) * oscillation
            x,y = plane@(position+swing)+[origin_x,origin_y]
            y = sh-y
            if -bounds[0]-size <= x <= sw+bounds[0]+size and -bounds[1]-size <= y <= sh+bounds[1]+size:
                visible.append(i)
            samples.append((x,y))
            velocity = (velocity+gravity*step)*math.exp(-drag*step)
            position = position+velocity*step
        if not visible:
            continue
        first, last = max(0,visible[0]-1), min(30,visible[-1]+1)
        segment = samples[first:last+1]
        if len(segment)<2:
            continue
        delay = round(rng.uniform(0,min(1800,life*220)))
        times = [delay+round(i*step*1000) for i in range(len(segment))]
        end = times[-1]+round(rng.uniform(550,2400))
        path = [(0,*segment[0]), *[(t,*p) for t,p in zip(times,segment)], (end,*segment[-1])]
        fade = [(0,0),(delay,0),(delay+max(1,round((times[-1]-delay)*fade_in)),opacity),
                (delay+round((times[-1]-delay)*fade_out),opacity),(times[-1],0),(end,0)]
        if prewarm:
            path,fade = prewarm_track(path,prewarm),prewarm_track(fade,prewarm)
        rotation = initial.get("rotationrandom", {})
        def angle_value(raw):
            return float(raw) if isinstance(raw,(int,float)) else numbers(raw,[0,0,0])[-1]
        angle = rng.uniform(angle_value(rotation.get("min",0)),angle_value(rotation.get("max",0)))
        width = size*scale_x/factor
        height = size*scale_y/factor
        layers.append({"id": f"{name}_{len(layers)}", "name": obj.get("name",name), "x":0,"y":0,
                       "w":width, "h":height, "rotation":-math.degrees(math.atan2(c,a)+angle),
                       "motion":motion, "travel":path, "fade":fade})
    if not layers:
        raise ValueError("粒子默认轨迹未进入画幅")
    asset, sequence, aspect = sprite_assets(assets, texture, material, name, descriptor, tint)
    for layer in layers:
        layer["asset"] = asset
        layer["h"] *= aspect
        if renderer == "spritetrail":
            layer["h"] *= .23
        if sequence:
            layer["sequence"] = sequence
    return layers


def cloud_overlay(assets, spec, width, height, count):
    texture = texture_at(spec, 1)
    if not texture:
        raise ValueError("缺少雾或尘粒噪声纹理")
    noise = np.asarray(assets.texture(texture), dtype=np.float32)[...,:1]/255
    factor = 620/max(width,height)
    size = (max(1,round(width*factor)),max(1,round(height*factor)))
    u,v = coords(size)
    threshold = scalar(spec,"threshold",.24,0,1)
    feather = scalar(spec,"feather",.28,.01,1)
    alpha = scalar(spec,"alpha",.52,0,1)
    scale = vector_values(spec["values"].get("scale"), [1,1,1,1])
    for i in range(count):
        phase = math.tau*i/count
        x,y = math.cos(phase)*.045,math.sin(phase)*.036
        a = bilinear(noise,u*scale[0]+x,v*scale[1]+y,repeat=True)[...,0]
        b = bilinear(noise,-v*scale[3]-y,u*scale[2]+x,repeat=True)[...,0]
        blend = np.clip((a*b-threshold)/feather,0,1)
        rgba = np.empty((size[1],size[0],4),np.uint8)
        rgba[...,:3] = [234,243,255]
        rgba[...,3] = np.rint(blend**2*(3-2*blend)*alpha*255).astype(np.uint8)
        yield Image.fromarray(rgba)


def source_text(assets, obj, geometry):
    text = property_default(obj.get("text"),{})
    if not isinstance(text,str) or not text.strip() or len(text)>1000:
        raise ValueError("脚本文字由手机时钟替代")
    font_path = obj.get("font")
    if not isinstance(font_path,str) or not font_path:
        raise ValueError("缺少原文字字体")
    size = tuple(max(1,min(1200,round(x))) for x in geometry)
    image = Image.new("RGBA",size)
    pixels = max(8,min(size[1]//2,round(float(property_default(obj.get("fontsize",obj.get("pointsize",32)),{}))*1.95)))
    font = ImageFont.truetype(BytesIO(assets.read(font_path)),pixels)
    ImageDraw.Draw(image).text((size[0]/2,size[1]/2),text,font=font,anchor="mm",fill="white")
    return image


def render_layer(assets, layer, obj, specs, grade, notes, key, surface_budget=None):
    base = layer["image"]
    warp = [(name,spec) for name,spec in specs if name in WARP_EFFECTS]
    depth = next((spec for name,spec in specs if name=="depthparallax"),None)
    unsupported = sorted({name for name,_ in specs if name not in WARP_EFFECTS|{"depthparallax","color_grading","opacity","tint"}})
    used = []
    if unsupported:
        notes.append(f"{layer['name']} · 未转换效果 {', '.join(unsupported)}")
    for name,spec in specs:
        if name=="opacity":
            layer["opacity"] *= scalar(spec,"opacity",scalar(spec,"alpha",1),0,1)
        if name=="tint":
            values = vector_values(spec["values"].get("tint",spec["values"].get("color")), [1,1,1])
            layer["color"] = [left*right for left,right in zip(layer["color"],values)]
        if name=="color_grading":
            base = grade_pixels(base,scalar(spec,"brightness",0,-1,1),scalar(spec,"contrast",0,-1,1))
    if layer.get("videoSource"):
        if not assets.fast:
            from 视频处理 import encode
            layer["video"]="assets/"+key+".mp4"
            encode(layer.pop("videoSource"),assets.stage/layer["video"],assets.fps)
        layer["asset"]=assets.write(key,finish_frame(base,layer,grade))
        return ["场景内嵌视频"]
    frames = None
    period = 0
    lossless = False
    if layer.get("puppet"):
        try:
            tracks = [track for track in obj.get("animationlayers",[]) if track.get("visible",True) and track.get("blend",1)]
            if not tracks:
                raise ValueError("骨骼没有启用的动画")
            track=tracks[0]
            rig=decode_rig(assets.read(layer["puppet"]), track["animation"])
            generated=render_cycle(rig,base,float(track.get("rate",1)),float(track.get("blend",1)),layout_size=layer["native_size"],first_only=assets.fast)
            image,bounds,period=next(generated)
            left,bottom,right,top=bounds
            native_w,native_h=layer["native_size"]
            sx,sy=layer["w"]/native_w,layer["h"]/native_h
            local_x,local_y=(left+right)*sx/2,-(bottom+top)*sy/2
            dx,dy=rotate(local_x,local_y,math.radians(layer["rotation"]))
            layer["x"]+=dx
            layer["y"]+=dy
            layer["w"],layer["h"]=(right-left)*sx,(top-bottom)*sy
            frames=chain([image],(frame for frame,_,_ in generated))
            used=["骨骼动画"]
            if len(tracks)>1:
                notes.append(f"{layer['name']} · 使用首个启用的骨骼动画，其余叠加动画未转换")
        except ASSET_ERRORS as exc:
            notes.append(f"{layer['name']} · 骨骼动画，{exc}")
    if assets.fast:
        if frames is not None:base=next(iter(frames))
        layer["asset"]=assets.write(key,finish_frame(base,layer,grade))
        return used
    if frames is None and layer.get("atlas"):
        try:
            images=atlas_frames(assets,layer["atlas"],trim=False)
            if len(images)>1:
                for image in images:
                    image.thumbnail((700,700),Image.Resampling.LANCZOS)
                frames=images
                period=max(120,round(len(images)*1000/20))
                used=["纹理帧动画"]
        except ASSET_ERRORS as exc:
            notes.append(f"{layer['name']} · 图集，{exc}")
    if frames is None and warp:
        period, count, width = surface_plan(base, warp, surface_budget)
        frames,used=surface_frames(assets,base,warp,width,period,count,notes,layer["name"])
        if not used:
            frames=None
        lossless = "iris" in used
    if frames is None and depth:
        frames,period=depth_frames(assets,base,depth),13
        used=["深度贴图视差"]
    if frames is not None:
        if warp and not set(used).intersection(WARP_EFFECTS):
            notes.append(f"{layer['name']} · 动画与材质叠加仅保留主要效果")
        if depth and used!=["深度贴图视差"]:
            notes.append(f"{layer['name']} · 同层循环与深度贴图未叠加，保留整层视差")
        seq=assets.sequence(key,(finish_frame(frame,layer,grade) for frame in frames),period,lossless=lossless)
        if used==["深度贴图视差"]:
            seq["mode"]="tilt"
        layer["sequence"]=seq
        layer["asset"]=seq["frames"][len(seq["frames"])//2 if seq.get("mode")=="tilt" else 0]
    else:
        layer["asset"]=assets.write(key,finish_frame(base,layer,grade))
    layer["image"]=Image.open(assets.stage/layer["asset"]).convert("RGBA")
    return used


def build_motion_scene(package, scene, properties, layers, worlds, stage, decode_texture, geometry, notes, fast=False, fps=30):
    assets = SceneAssets(package, stage, decode_texture, fast=fast)
    assets.fps = fps
    sw,sh = (float(scene["general"]["orthogonalprojection"][axis]) for axis in ("width","height"))
    layers_by_id={layer["id"]:layer for layer in layers}
    objects=scene["objects"]
    grade=(0,0)
    for obj in objects:
        if obj.get("image")!="models/util/fullscreenlayer.json" or worlds.get(obj["id"]) is None:
            continue
        for name,spec in effects_for(obj,properties):
            if name=="color_grading":
                grade=scalar(spec,"brightness",0,-1,1),scalar(spec,"contrast",0,-1,1)
    result, restored, particle_count=[],[],0
    ignored_mouse=[]
    pending_emitters = sum(bool(obj.get("particle")) and (worlds.get(obj["id"]) or {}).get("alpha",0)>0 for obj in objects)
    object_specs = {obj["id"]: effects_for(obj, properties) for obj in objects if worlds.get(obj["id"])}
    for identifier,specs in object_specs.items():
        if any(kind=='cursorripple' for kind,_ in specs):ignored_mouse.append(str(identifier)+':cursorripple')
        object_specs[identifier]=[(kind,spec) for kind,spec in specs if kind!='cursorripple']
    pending_surfaces = sum(
        any(kind in WARP_EFFECTS for kind,_ in object_specs.get(layer["id"], [])) for layer in layers
    )
    if grade!=(0,0):
        restored.append("全局亮度和对比度")
    for index,obj in enumerate(objects):
        state=worlds.get(obj["id"])
        if state is None or state["alpha"]<=0:
            continue
        name=str(obj.get("name",obj["id"]))
        key=f"object_{index:03d}"
        specs=object_specs[obj["id"]]
        base=layers_by_id.get(obj["id"])
        if base is not None:
            layer=dict(base)
            surface_budget = None
            if any(kind in WARP_EFFECTS for kind,_ in specs):
                remaining = ANIMATION_PIXEL_LIMIT - assets.animated_pixels
                surface_budget = int(.88 * remaining / max(1, pending_surfaces))
                pending_surfaces -= 1
            try:
                used=render_layer(assets,layer,obj,specs,grade,notes,key,surface_budget)
                restored.extend(used)
            except ASSET_ERRORS as exc:
                notes.append(f"{name} · 动画未生成，{exc}")
                layer=dict(base)
                image=finish_frame(layer["image"],layer,grade)
                layer["asset"]=assets.write(key+"_static",image)
                layer["image"]=image
            result.append(layer)
        elif isinstance(obj.get("particle"),str) and obj["particle"]:
            try:
                descriptor=assets.json(obj['particle'])
                if any((point.get('flags',0) or 0)&1 for point in descriptor.get('controlpoint',[])):
                    ignored_mouse.append(name)
                    continue
                if particle_count>=PARTICLE_LIMIT:
                    raise ValueError("已到粒子图层上限")
                share = max(1, (PARTICLE_LIMIT-particle_count)//max(1,pending_emitters))
                particles=sprite_tracks(assets,obj,state,sw,sh,key,share,properties)
                result.extend(particles)
                particle_count+=len(particles)
                if particles:
                    restored.append("粒子贴图、位移与淡入淡出")
                if any(layer.get("sequence") for layer in particles):
                    restored.append("粒子帧图集")
            except ASSET_ERRORS as exc:
                notes.append(f"{name} · 粒子，{exc}")
            finally:
                pending_emitters -= 1
        elif obj.get("sound"):
            notes.append(f"{name} · 音轨暂未转换")
        elif isinstance(property_default(obj.get("text"),{}),str) and property_default(obj["text"],{}).strip():
            try:
                size=vector_values(obj.get("size"),[300,100])
                image=source_text(assets,obj,size)
                layer={"id":obj["id"],"name":name,**geometry(state,size,sh)}
                layer["image"]=finish_frame(image,layer,grade)
                layer["asset"]=assets.write(key,layer["image"],False)
                result.append(layer)
            except ASSET_ERRORS as exc:
                notes.append(f"{name} · 文字，{exc}")
        elif specs:
            for effect_index,(effect,spec) in enumerate(specs):
                if effect=="color_grading" and obj.get("image")=="models/util/fullscreenlayer.json":
                    continue
                if effect=="clouds":
                    try:
                        size=vector_values(obj.get("size"),[sw,sh])
                        layer={"id":f"{obj['id']}_overlay_{effect_index}","name":name,**geometry(state,size,sh)}
                        if fast:
                            layer["asset"]=assets.write(key+"_clouds",next(cloud_overlay(assets,spec,*size[:2],18)))
                        else:
                            layer["sequence"]=assets.sequence(f"{key}_clouds_{effect_index}",cloud_overlay(assets,spec,*size[:2],18),5600)
                            layer["asset"]=layer["sequence"]["frames"][0]
                        layer["image"]=Image.open(stage/layer["asset"]).convert("RGBA")
                        result.append(layer)
                        restored.append("雾尘纹理流动")
                    except ASSET_ERRORS as exc:
                        notes.append(f"{name} · 雾尘，{exc}")
                elif effect not in {"blurprecise"}:
                    notes.append(f"{name} · 合成层效果 {effect} 暂未转换")
    details={"原图层数":len(layers),"粒子图层数":particle_count,"动效位图数":len(assets.saved),"按用户要求忽略的鼠标交互":ignored_mouse,
             "解码像素上界":sum(w*h for w,h in assets.saved.values())}
    return result,list(dict.fromkeys(restored)),details


def coords(size):
    w, h = size
    return np.meshgrid((np.arange(w, dtype=np.float32) + .5) / w,
                       (np.arange(h, dtype=np.float32) + .5) / h)


def grade_pixels(image, brightness, contrast):
    # 原色彩校正的亮度和对比度在背屏文字之前作用。
    table = [max(0, min(255, round((i * (1 + brightness) - 127.5) * (1 + contrast) + 127.5)))
             for i in range(256)]
    return image.convert("RGBA").point(table * 3 + list(range(256)))


def scalar_texture(assets, name, size):
    if not name:
        return 1.0
    texture = assets.texture(name).getchannel("R").resize(size, Image.Resampling.BILINEAR)
    return np.asarray(texture, dtype=np.float32) / 255


def rotate(u, v, angle):
    return u * math.cos(angle) - v * math.sin(angle), u * math.sin(angle) + v * math.cos(angle)


def texture_at(spec, index, default=None):
    items = spec["textures"]
    return (items[index] or default) if index < len(items) else default


def scalar(spec, name, default, lo=-1000., hi=1000.):
    value = float(spec["values"].get(name, default))
    if not math.isfinite(value):
        raise ValueError("特效参数无效")
    return min(hi, max(lo, value))


def shake_displacement(assets, spec, size, u, v):
    if spec["combos"].get("AUDIOPROCESSING"):
        raise ValueError("音频驱动的摇摆暂未支持")
    path = texture_at(spec, 1)
    if not path:
        return lambda seconds: (0.0, 0.0)
    texture = assets.texture(path).resize(size, Image.Resampling.BILINEAR)
    # 摇摆的前两个通道分别是 X 和 Y，127 表示没有位移。
    flow = (np.asarray(texture, dtype=np.float32)[..., :2] - 127) * (2/255)
    strength = scalar(spec, "strength", .1, 0, .5)**2
    speed = scalar(spec, "speed", 1, 0, 10)
    lo, hi = numbers(spec["values"].get("bounds"), [0, 1])
    friction_up, friction_down = numbers(spec["values"].get("friction"), [1, 1])
    friction_up = max(.01, friction_up)
    friction_down = max(.01, friction_down)
    direction = int(spec["combos"].get("DIRECTION", 0))
    noise = bool(spec["combos"].get("NOISE", 0))
    time_mask = texture_at(spec, 2)
    phase = scalar_texture(assets, time_mask, size) * math.tau if time_mask else 0
    opacity_path = texture_at(spec, 3)
    opacity = np.asarray(scalar_texture(assets, opacity_path, size))[..., None] if opacity_path else None

    def oscillate(angle):
        wave = np.sin(angle) * .498 + .5
        return np.where(np.cos(angle) >= 0, wave**friction_down, 1-(1-wave)**friction_up)

    def displacement(seconds):
        time = speed*seconds
        if noise:
            value = sum(oscillate(phase + time*frequency) for frequency in (1, -.16161616, .0083333, -.00019841))*.5
        else:
            value = oscillate(time+phase)
        value = np.clip((value-lo)/max(.001, hi-lo), 0, 1)
        if direction == 0:
            value = 2*value-1
        elif direction == 2:
            value -= 1
        offset = flow * (strength * np.asarray(value)[..., None])
        if opacity is not None:
            offset *= bilinear(opacity, u+offset[..., 0], v+offset[..., 1])
        return offset[..., 0], offset[..., 1]
    return displacement


def iris_displacement(spec, mask):
    if spec["combos"].get("BACKGROUND"):
        raise ValueError("带背景填色的虹膜组合暂未支持")
    scale_x, scale_y = numbers(spec["values"].get("scale"), [1, 1])
    speed = scalar(spec, "speed", 1, .01, 2)
    rough = scalar(spec, "rough", .2, .01, 1)
    noise = scalar(spec, "noiseamount", .5, 0, 2)
    phase = scalar(spec, "phase", 0, -1, 1)

    def eye_vector(step):
        common = math.sin(1.9*step)
        return common+math.sin(2.5*step+1), common+math.sin(2.5*step+2)

    def displacement(seconds):
        time = seconds*speed+phase
        step = math.floor(time)
        weight = .5-.5*math.cos((time-step)*math.pi)
        weight = max(0, min(1, (weight-1+rough)/rough))
        weight = weight*weight*(3-2*weight)
        start_x,start_y = eye_vector(step)
        end_x,end_y = eye_vector(step+1)
        x = start_x + (end_x-start_x)*weight + math.sin(time)*noise
        y = start_y + (end_y-start_y)*weight + math.cos(time)*noise
        return mask*x*scale_x*.001, mask*y*scale_y*.001
    return displacement


def surface_displacement(assets, kind, spec, size, u, v, period):
    """把已知材质参数转成以秒为单位的局部纹理位移。"""
    if kind == "shake":
        return shake_displacement(assets, spec, size, u, v)
    aspect = size[0] / size[1]
    mask = scalar_texture(assets, texture_at(spec, 1), size)
    if kind == "iris":
        return iris_displacement(spec, mask)
    strength = scalar(spec, "strength", .1, 0, 2) ** 2
    direction = scalar(spec, "direction", scalar(spec, "scrolldirection", 0))
    dx, dy = math.sin(direction), math.cos(direction)
    if kind == "waterripple":
        texture = assets.texture(texture_at(spec, 2, "effects/waterripplenormal"))
        normal = np.asarray(texture.filter(ImageFilter.GaussianBlur(.55)), dtype=np.float32)[..., :3] / 127.5 - 1
        scale = scalar(spec, "scale", 1, .01, 20)
        rx, ry = scale*aspect, scale*scalar(spec, "ratio", 1, .01, 20)
        amp = scalar(spec, "ripplestrength", .08, 0, .4) ** 2 * mask
        if texture_at(spec, 1) is None:
            amp *= .43
        travel = max(.011, scalar(spec, "animationspeed", .08, 0, .5)**2 * period / 1000 * 2.5)

        def ripple(seconds):
            phase = seconds*1000/period*math.tau
            a, b = math.sin(phase)*travel, math.cos(phase)*travel
            first = bilinear(normal, (u+a)*rx, (v+b)*ry, repeat=True)
            second = bilinear(normal, (u*1.333-b)*rx, (v*1.333-a)*ry, repeat=True)
            x, y = first[..., 0] + second[..., 0], first[..., 1] + second[..., 1]
            length = np.sqrt(x*x+y*y+first[..., 2]**2).clip(.0001)
            return x/length*amp, y/length*amp
        return ripple
    if kind == "waterwaves":
        spatial = (u*dx+v*dy)*scalar(spec, "scale", 20, 0, 300)
        power = scalar(spec, "exponent", 1, .25, 4)
        offset_map = texture_at(spec, 2)
        if offset_map:
            spatial += scalar_texture(assets, offset_map, size)*math.tau

        speed = scalar(spec, "speed", 3, 0, 20)

        def wave(seconds):
            value = np.sin(spatial+seconds*speed)
            shift = np.sign(value)*np.abs(value)**power*strength*mask
            return shift*dy, -shift*dx
        return wave
    if kind == "foliagesway":
        if spec["combos"].get("MODE"):
            raise ValueError("顶点模式的风摆暂未支持")
        wind = scalar(spec, "scrolldirection", 0)
        x, y = rotate(u, v, wind)
        ratio = aspect*scalar(spec, "ratio", .3, .03, 6)
        scale = scalar(spec, "scale", .05, 0, 20)
        noise_path = texture_at(spec, 2, "util/noise")
        if assets.texture_bytes(noise_path):
            noise = np.asarray(assets.texture(noise_path), dtype=np.float32)[..., 1:2] / 255
            noise = bilinear(noise, u*scale, v*scale, repeat=True)[..., 0]
        else:
            noise = (np.sin(8*u+13*v)+1)*.5
        local_phase = (noise*math.tau+x*10+y*5)*scalar(spec, "phase", .5)
        side, up = rotate(1/ratio, ratio, wind)
        amp = scalar(spec, "strength", .4, 0, 1)**2*.005*mask
        speed = scalar(spec, "speeduv", 5, .01, 20)
        power = scalar(spec, "power", 1, .01, 2)

        def wobble(time, offset, harmonics):
            result = 0
            for frequency in harmonics:
                value = np.sin(offset + local_phase + time*frequency)
                result += value if power == 1 else np.sign(value)*np.abs(value)**power
            return result

        def foliage(seconds):
            time = seconds*speed
            x = wobble(time, 0, (1, -.16161616, .0083333, -.00019841))
            y = wobble(time, .4, (-.5, .041666666, -.0013888889, .000024801587))
            return x*amp*side, y*amp*up
        return foliage
    if kind == "waterflow":
        flow_path = texture_at(spec, 1, "util/noflow")
        raw = np.asarray(assets.texture(flow_path).resize(size, Image.Resampling.BILINEAR), dtype=np.float32)
        motion = (raw[..., :2]/127.5-1)*scalar(spec, "strength", 1, 0, 2)*.022
        phase_map = texture_at(spec, 2)
        pattern = scalar_texture(assets, phase_map, size)*math.tau if phase_map else 0
        return lambda seconds: (motion[..., 0]*np.sin(seconds*1000/period*math.tau+pattern),
                                motion[..., 1]*np.sin(seconds*1000/period*math.tau+pattern))
    amp = scalar(spec, "strength", .08, 0, .5)*.16*mask
    return lambda seconds: (amp*dx*math.sin(seconds*1000/period*math.tau), amp*dy*math.sin(seconds*1000/period*math.tau))


def vector_values(raw, default):
    raw = raw.split() if isinstance(raw, str) else raw
    if not isinstance(raw, (list, tuple)):
        return list(default)
    values = [float(x) for x in raw]
    if not all(math.isfinite(x) for x in values):
        raise ValueError("参数含无效数字")
    return values


def premultiplied(image):
    pixels = np.array(image, dtype=np.float32)
    pixels[..., :3] *= pixels[..., 3:] / 255
    return pixels


def unpremultiplied(rgba):
    rgba[..., :3] *= 255 / np.maximum(1, rgba[..., 3:])
    return Image.fromarray(np.clip(np.rint(rgba), 0, 255).astype(np.uint8))


def resize_size(image, width):
    ratio = min(1., width / max(image.size))
    return tuple(max(1, round(v * ratio)) for v in image.size)


def surface_plan(image, specs, pixel_budget):
    durations = []
    for kind,spec in specs:
        if kind in {"shake", "waterwaves"}:
            durations.append(math.tau/scalar(spec, "speed", 1 if kind == "shake" else 3, .05, 20))
        elif kind == "foliagesway":
            durations.append(2*math.tau/scalar(spec, "speeduv", 5, .05, 20))
        elif kind == "iris":
            durations.append(5/scalar(spec, "speed", 1, .05, 2))
        else:
            durations.append(2.4)
    seconds = min(8, max(1.6, max(durations)))
    count = max(12, round(seconds*12))
    pixels = ANIMATION_PIXEL_LIMIT if pixel_budget is None else pixel_budget
    target = min(1032, max(image.size))
    per_frame = pixels // count
    if per_frame < 1:
        raise ValueError("剩余纹理预算不足")
    aspect = max(image.size)/min(image.size)
    width = max(1, min(target, math.floor(math.sqrt(per_frame*aspect))))
    while math.prod(resize_size(image, width)) > per_frame:
        width -= 1
    return round(seconds*1000), count, width


def surface_frames(assets, image, specs, width, period, count, notes, label):
    size = resize_size(image, width)
    pixels = premultiplied(image.resize(size, Image.Resampling.LANCZOS))
    u, v = coords(size)
    warps, pulses, converted = [], [], []
    for kind, spec in specs:
        try:
            if kind == "pulse":
                low = np.clip(vector_values(spec["values"].get("tintlow"), [1,1,1])[:3], 0, 2)
                high = np.clip(vector_values(spec["values"].get("tinthigh"), [1,1,1])[:3], 0, 2)
                mask = scalar_texture(assets, texture_at(spec, 2), size)
                pulses.append((low, high, np.asarray(mask)[..., None], scalar(spec,"amount",1,0,1), spec["combos"].get("PULSEALPHA")))
            else:
                warps.append(surface_displacement(assets, kind, spec, size, u, v, period))
            converted.append(kind)
        except ASSET_ERRORS as exc:
            notes.append(f"{label} · {kind}，{exc}")

    def sample_coords(seconds):
        sx, sy = u, v
        for warp in warps:
            dx, dy = warp(seconds)
            sx, sy = sx+dx, sy+dy
        return sx, sy

    def frames():
        duration = period/1000
        seam = min(.65, .13*duration)
        for i in range(count):
            seconds = i*duration/count
            sx, sy = sample_coords(seconds)
            if seconds > duration-seam:
                # 仅在循环接缝附近过渡位移，主体仍按原参数随时间播放。
                weight = (seconds-duration+seam)/seam
                weight = weight*weight*(3-2*weight)
                head_x, head_y = sample_coords(seconds-duration)
                sx, sy = sx+(head_x-sx)*weight, sy+(head_y-sy)*weight
            frame = bilinear(pixels, sx, sy)
            for low, high, mask, amount, pulse_alpha in pulses:
                weight = .5 + .5*math.sin(i*math.tau/count)
                frame[..., :3] *= 1 + ((low*(1-weight)+high*weight)-1)*mask*amount
                if pulse_alpha:
                    frame *= 1 - (1-weight)*mask*amount
            yield unpremultiplied(frame)
    return frames(), converted


def depth_frames(assets, image, spec, count=13):
    size = resize_size(image, 640)
    source = premultiplied(image.resize(size, Image.Resampling.LANCZOS))
    mask = texture_at(spec, 1)
    if mask is None:
        raise ValueError("缺少深度贴图")
    depth = scalar_texture(assets, mask, size)*2-1
    scales = vector_values(spec["values"].get("scale"), [1, 1])
    u, v = coords(size)
    for tilt in np.linspace(-1, 1, count):
        shift = depth*tilt*.019*scales[0]
        yield unpremultiplied(bilinear(source, u+shift, v))


def atlas_frames(assets, texture_name, trim=True, first_only=False):
    data = assets.texture_bytes(texture_name)
    if data is None or not data.startswith(b"TEXV0005\0TEXI0001\0"):
        raise ValueError("纹理图集缺失或格式不受支持")
    offset = max(data.rfind(b"TEXS0001\0"), data.rfind(b"TEXS0002\0"), data.rfind(b"TEXS0003\0"))
    if offset < 0:
        raise ValueError("纹理图集缺少帧索引")
    count, = struct.unpack_from("<I", data, offset + 9)
    start = offset + (21 if data[offset:offset + 8] == b"TEXS0003" else 13)
    if not 1 <= count <= 192 or start + count * 32 > len(data):
        raise ValueError("飞鸟帧索引超出图集")
    single = bytearray(data)
    texture_format, = struct.unpack_from("<I", single, 18)
    flags, = struct.unpack_from("<I", single, 22)
    struct.pack_into("<I", single, 22, flags & ~4)
    atlas = as_albedo(assets.decode_texture(single), texture_format)
    frames = []
    for index in range(1 if first_only else count):
        fmt = "<If6i" if data[offset:offset+8] == b"TEXS0001" else "<I7f"
        image_id, _, x, y, xx, xy, yx, yy = struct.unpack_from(fmt, data, start + index * 32)
        width, height = round(math.hypot(xx, xy)), round(math.hypot(yx, yy))
        if image_id != 0 or not (0 < width <= 1600 and 0 < height <= 1600):
            raise ValueError("纹理图集的帧尺寸无效")
        if count*width*height > 36_000_000:
            raise ValueError("纹理图集展开后过大")
        frame = atlas.transform((width, height), Image.Transform.AFFINE,
                                (xx / width, yx / height, x, xy / width, yy / height, y),
                                resample=Image.Resampling.BILINEAR)
        frames.append(frame)
    if not trim:
        return frames
    # 各帧在同一原始画布中裁切，避免拍翼时位置抖动。
    bounds = [im.getbbox() for im in frames if im.getbbox()]
    if not bounds:
        raise ValueError("纹理图集没有有效像素")
    box = (min(b[0] for b in bounds), min(b[1] for b in bounds),
           max(b[2] for b in bounds), max(b[3] for b in bounds))
    result = []
    for frame in frames:
        trimmed = frame.crop(box)
        trimmed.thumbnail((128, 96), Image.Resampling.LANCZOS)
        result.append(trimmed)
    return result
