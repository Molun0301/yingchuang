#!/usr/bin/env python3
"""把可解析的平面壁纸转换为 RearEye 原生背屏包。"""

from __future__ import annotations

import argparse
from datetime import datetime
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import struct
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

try:
    from PIL import Image
except ImportError:
    raise SystemExit("缺少图像库。请先运行同目录的一键转换启动器，或安装 requirements.txt 中的依赖。")

ROOT = Path(__file__).resolve().parent
DEFAULTS = {
    "预览宽度": 976, "预览高度": 596, "画面缩放": 1.06,
    "横向取景": .5, "纵向取景": .5, "避让左侧比例": .30,
    "文字中心位置": .74,
    "感应幅度": .020, "感应灵敏度": 4., "平滑系数": .16,
    "横向方向": -1, "纵向方向": 1, "纵向感应比例": .30,
    "帧率": 30, "显示秒": False, "星期语言": "英文",
    "文字颜色": "原主题", "纹理最长边": 1920, "署名": "",
}
MAX_FILE = 256 * 1024 * 1024
MAX_PIXELS = 32 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ConversionError(ValueError):
    """可以直接向用户说明的转换错误。"""


class Reader:
    def __init__(self, data):
        self.data = memoryview(data)
        self.pos = 0

    def take(self, size):
        if not 0 <= size <= MAX_FILE or self.pos + size > len(self.data):
            raise ConversionError("资源长度无效或文件已截断。")
        data = bytes(self.data[self.pos:self.pos + size])
        self.pos += size
        return data

    def u32(self):
        return struct.unpack("<I", self.take(4))[0]

    def i32(self):
        return struct.unpack("<i", self.take(4))[0]

    def cstr(self):
        value = bytearray()
        for _ in range(32):
            b = self.take(1)
            if b == b"\0":
                return value.decode("ascii")
            value.extend(b)
        raise ConversionError("纹理标记过长。")


def safe_name(name):
    name = name.replace("\\", "/")
    p = PurePosixPath(name)
    if p.is_absolute() or ".." in p.parts or ":" in name or "\0" in name or not p.parts:
        raise ConversionError("资源路径无效。")
    return str(p)


class Package:
    """按索引读取，不向磁盘展开不需要的资源。"""

    def __init__(self, source):
        self.path = source
        self.entries = {}
        total = source.stat().st_size
        with source.open("rb") as f:
            def take(n):
                if not 0 <= n <= MAX_FILE:
                    raise ConversionError("资源索引长度无效。")
                b = f.read(n)
                if len(b) != n:
                    raise ConversionError("壁纸资源包已截断。")
                return b

            def u32():
                return struct.unpack("<I", take(4))[0]

            if u32() != 8:
                raise ConversionError("不是支持的 Wallpaper Engine 资源包。")
            version = take(8).decode("ascii")
            if not re.fullmatch(r"PKGV[0-9]{4}", version) or not 2 <= int(version[4:]) <= 24:
                raise ConversionError("暂不支持的资源包版本：" + version)
            self.version = version
            count = u32()
            if not 1 <= count <= 50000:
                raise ConversionError("资源数量无效。")
            for _ in range(count):
                length = u32()
                if not 1 <= length <= 4096:
                    raise ConversionError("资源名称长度无效。")
                name = safe_name(take(length).decode("utf-8"))
                offset, size = u32(), u32()
                if name in self.entries or size > MAX_FILE:
                    raise ConversionError("资源名称重复或资源过大。")
                self.entries[name] = (offset, size)
            self.base = f.tell()
        if any(self.base + offset + size > total for offset, size in self.entries.values()):
            raise ConversionError("资源索引超出文件长度。")
        self.names = {name.casefold(): name for name in self.entries}

    def has(self, name):
        return safe_name(name).casefold() in self.names

    def read(self, name):
        name = safe_name(name)
        if name not in self.entries:
            resolved = self.names.get(name.casefold())
            if resolved is None:
                raise ConversionError("资源包中缺少：" + name)
            name = resolved
        offset, size = self.entries[name]
        with self.path.open("rb") as f:
            f.seek(self.base + offset)
            data = f.read(size)
        if len(data) != size:
            raise ConversionError("读取期间资源包发生变化。")
        return data

    def json(self, name):
        data = self.read(name)
        if len(data) > 8 * 1024 * 1024:
            raise ConversionError("场景描述过大。")
        return json.loads(data.decode("utf-8-sig"))


class SceneFolder:
    """解包后的工程使用与资源包相同的只读接口。"""

    def __init__(self, path):
        self.path = path
        self.root = path.parent.resolve()

    def asset_path(self, name):
        file = (self.root / safe_name(name)).resolve()
        if not file.is_relative_to(self.root):
            raise ConversionError("资源路径超出工程目录。")
        return file

    def has(self, name):
        return self.asset_path(name).is_file()

    def read(self, name):
        path = self.asset_path(name)
        if not path.is_file() or path.stat().st_size > MAX_FILE:
            raise ConversionError("场景文件缺失或过大：" + name)
        return path.read_bytes()

    json = Package.json


def bounded_image(image):
    if min(image.size) < 1 or image.width * image.height > MAX_PIXELS:
        raise ConversionError("图像尺寸超过支持范围。")
    image.load()
    return image.convert("RGBA")


def decode_tex(data):
    """解析常用静态纹理；动画图集和视频明确拒绝。"""
    r = Reader(data)
    if r.cstr() != "TEXV0005" or r.cstr() != "TEXI0001":
        raise ConversionError("未知纹理版本。")
    fmt, flags, tw, th, iw, ih, unused = [r.i32() for _ in range(7)]
    if min(tw, th, iw, ih) < 1 or max(tw * th, iw * ih) > MAX_PIXELS:
        raise ConversionError("纹理尺寸超出限制。")
    if flags & (4 | 32):
        raise ConversionError("动画图集或视频纹理需要单独移植。")
    kind = r.cstr()
    if kind not in {"TEXB0001", "TEXB0002", "TEXB0003", "TEXB0004"}:
        raise ConversionError("未知纹理容器：" + kind)
    count = r.u32()
    if count != 1:
        raise ConversionError("多图纹理需要单独移植。")
    image_format = r.i32() if kind in {"TEXB0003", "TEXB0004"} else -1
    if kind == "TEXB0004" and r.u32() == 1:
        raise ConversionError("视频纹理需要单独移植。")
    mips = r.u32()
    if not 1 <= mips <= 32:
        raise ConversionError("纹理层级数量无效。")
    w, h = r.u32(), r.u32()
    if min(w, h) < 1 or w * h > MAX_PIXELS:
        raise ConversionError("纹理层级尺寸无效。")
    compressed, expected = (r.u32(), r.u32()) if kind != "TEXB0001" else (0, 0)
    if compressed not in {0, 1} or expected > MAX_FILE:
        raise ConversionError("纹理压缩信息无效。")
    payload = r.take(r.u32())
    if compressed:
        try:
            import lz4.block
        except ImportError:
            raise ConversionError("此纹理需要 lz4 解压库，请运行一键转换启动器安装依赖。")
        payload = lz4.block.decompress(payload, uncompressed_size=expected)
        if len(payload) != expected:
            raise ConversionError("纹理解压长度不一致。")
    if image_format >= 0:
        return bounded_image(Image.open(io.BytesIO(payload)))
    if fmt in {4, 6, 7}:
        # 让图像库负责标准块压缩解码，不自行重写颜色插值。
        code = {4: b"DXT5", 6: b"DXT3", 7: b"DXT1"}[fmt]
        words = [124, 0xA1007, h, w, len(payload), 0, 0] + [0] * 11
        header = struct.pack("<18I", *words)
        header += struct.pack("<II4sIIIII", 32, 4, code, 0, 0, 0, 0, 0)
        header += struct.pack("<5I", 0x1000, 0, 0, 0, 0)
        image = bounded_image(Image.open(io.BytesIO(b"DDS " + header + payload)))
    elif fmt == 0:
        image = Image.frombytes("RGBA", (w, h), payload)
    elif fmt == 9:
        image = Image.frombytes("L", (w, h), payload).convert("RGBA")
    elif fmt == 8:
        red = Image.frombytes("L", (w, h), payload[::2])
        green = Image.frombytes("L", (w, h), payload[1::2])
        image = Image.merge("RGBA", (red, green, Image.new("L", (w, h)), Image.new("L", (w, h), 255)))
    else:
        raise ConversionError("暂不支持的原始纹理格式：" + str(fmt))
    if iw > image.width or ih > image.height:
        raise ConversionError("纹理裁切尺寸无效。")
    return image.crop((0, 0, iw, ih))


def value(x, default=None):
    return x.get("value", default) if isinstance(x, dict) else (default if x is None else x)


def vector(x, default):
    x = value(x, default)
    if isinstance(x, str):
        result = [float(v) for v in x.split()]
    elif isinstance(x, (list, tuple)):
        result = [float(v) for v in x]
    elif isinstance(x, (int, float)):
        # 作者常把一个滑块绑定到缩放或视差向量，表示各轴使用同一值。
        result = [float(x)] * len(default)
    else:
        raise ConversionError("图层向量格式不支持。")
    if not all(math.isfinite(v) for v in result):
        raise ConversionError("图层坐标不是有限数字。")
    return result


def visible(obj, props):
    v = obj.get("visible", True)
    if not isinstance(v, dict):
        return bool(v)
    user = v.get("user")
    if isinstance(user, str) and user in props:
        return bool(props[user].get("value", True))
    if isinstance(user, dict) and user.get("name") in props:
        return str(props[user["name"]].get("value")) == str(user.get("condition"))
    return bool(v.get("value", True))


def scene_background(scene):
    """场景底色：电脑上各图层透明处露出的颜色，未设置时渲染器按黑色清屏。"""
    general = scene.get("general", {})
    if general.get("clearenabled") is False:
        return "#000000"
    rgb = vector(general.get("clearcolor"), [0., 0., 0.])[:3]
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02x}" for v in rgb)


def property_value(raw, properties, default=None):
    if isinstance(raw, dict) and isinstance(raw.get("user"), str):
        prop = properties.get(raw["user"], {})
        if isinstance(prop, dict) and "value" in prop:
            return prop["value"]
    return value(raw, default)


def read_scene(source):
    pkg = Package(source) if source.suffix.lower() == ".pkg" else SceneFolder(source)
    project_path = source.parent / "project.json"
    project = json.loads(project_path.read_text(encoding="utf-8-sig")) if project_path.is_file() else {}
    if str(project.get("type", "scene")).lower() != "scene":
        raise ConversionError("该工程类型不是场景壁纸。请选择场景包、解包的场景或图片。")
    path = source.name if isinstance(pkg, SceneFolder) else project.get("file", "scene.json")
    if isinstance(pkg, Package) and (not isinstance(path, str) or not pkg.has(path)):
        path = "scene.json"
    scene = pkg.json(path)
    general = scene.get("general", {})
    projection = general.get("orthogonalprojection")
    if not isinstance(projection, dict):
        raise ConversionError("此工具只支持有正交画布的平面场景。")
    sw, sh = float(projection["width"]), float(projection["height"])
    if not (0 < sw <= 32768 and 0 < sh <= 32768):
        raise ConversionError("场景画布尺寸无效。")
    props = project.get("general", {}).get("properties", {})
    objects = scene.get("objects", [])
    if not isinstance(objects, list) or len(objects) > 4000 or not isinstance(props, dict):
        raise ConversionError("场景图层或设置结构无效。")
    return pkg, project, scene, sw, sh, props


def world_transforms(objects, props, sw, sh, notes):
    """按父子关系合成平面变换和透明度。"""
    by_id = {o["id"]: o for o in objects}
    if len(by_id) != len(objects):
        raise ConversionError("场景图层编号重复。")
    cache = {}
    visiting = set()

    def get_transform(obj):
        obj_id = obj["id"]
        if obj_id in cache:
            return cache[obj_id]
        if not visible(obj, props):
            cache[obj_id] = None
            return None
        if obj_id in visiting or len(visiting) >= 100:
            raise ConversionError("场景图层存在循环父级或嵌套过深。")
        visiting.add(obj_id)
        parent_id = obj.get("parent")
        parent = get_transform(by_id[parent_id]) if parent_id in by_id else None
        visiting.remove(obj_id)
        if parent_id in by_id and parent is None:
            cache[obj_id] = None
            return None
        origin = vector(property_value(obj.get("origin"), props), [0, 0, 0] if parent else [sw/2, sh/2, 0])
        scales = vector(property_value(obj.get("scale"), props), [1, 1, 1])
        angles = vector(property_value(obj.get("angles"), props), [0, 0, 0])
        if len(origin) < 2 or len(scales) < 2 or len(angles) < 3:
            raise ConversionError("图层坐标维数不足。")
        if abs(angles[0]) > .0001 or abs(angles[1]) > .0001:
            raise ConversionError("三维旋转需要单独适配。")
        angle = angles[2]
        sx, sy = scales[:2]
        co, si = math.cos(angle), math.sin(angle)
        a, b, c, d = co*sx, -si*sy, si*sx, co*sy
        x, y = origin[:2]
        alpha = float(property_value(obj.get("alpha"), props, 1))
        color = vector(property_value(obj.get("color"), props), [1, 1, 1])
        if len(color) < 3 or not math.isfinite(alpha):
            raise ConversionError("图层透明度或颜色无效。")
        alpha = min(1, max(0, alpha))
        color = [min(1, max(0, k)) for k in color[:3]]
        depth = vector(obj.get("parallaxDepth"), [parent["depth"] if parent else 0, 0])[0]
        if parent:
            pa, pb, pc, pd, px, py = parent["matrix"]
            a, b, c, d = pa*a + pb*c, pa*b + pb*d, pc*a + pd*c, pc*b + pd*d
            x, y = pa*x + pb*y + px, pc*x + pd*y + py
            alpha *= parent["alpha"]
            color = [left * right for left, right in zip(color, parent["color"])]
        result = {"matrix": (a,b,c,d,x,y), "alpha": alpha, "color": color, "depth": depth}
        cache[obj_id] = result
        return result

    for obj in objects:
        try:
            get_transform(obj)
        except (ValueError, TypeError, IndexError) as exc:
            notes.append(f"{obj.get('name', obj['id'])}：{exc}")
            cache[obj["id"]] = None
            visiting.clear()
    return cache


def layer_geometry(state, size, height):
    a, b, c, d, x, y = state["matrix"]
    sx, sy = math.hypot(a, c), math.hypot(b, d)
    if sx * sy <= 1e-10 or abs(a*b+c*d)/(sx*sy) > .002:
        raise ConversionError("图层缩放为零或父级变换产生斜切。")
    w, h = size[0] * sx, size[1] * sy
    if not (0 < w <= 100000 and 0 < h <= 100000):
        raise ConversionError("图层尺寸无效。")
    depth = state["depth"]
    return {"x": x, "y": height-y, "w": w, "h": h, "rotation": -math.degrees(math.atan2(c,a)),
            "flip_y": a*d-b*c < 0, "motion": min(2.,max(.2,1+depth*.45)),
            "source_depth": depth, "opacity": state["alpha"], "color": state["color"]}


def scene_layers(source, config, data=None, worlds=None, stage=None, media_root=None, fast=False):
    from 场景动效 import SceneAssets, atlas_frames, effects_for
    pkg, project, scene, sw, sh, props = data if data is not None else read_scene(source)
    objects = scene["objects"]
    layers, notes = [], []
    if worlds is None:
        worlds = world_transforms(objects, props, sw, sh, notes)
    assets = SceneAssets(pkg, stage, decode_tex, fast=fast)

    for obj in objects:
        name = obj.get("name", str(obj.get("id", "图层")))
        state = worlds.get(obj["id"])
        if state is None or state["alpha"] <= 0:
            continue
        image_path = obj.get("image")
        if not isinstance(image_path, str) or not image_path:
            continue
        try:
            if image_path == "models/util/solidlayer.json":
                size = vector(obj.get("size"), [256,256])
                # 音频条的底图只是着色器输入，直接显示会遮住整幅画面。
                if any("audio_bars" in effect.get("file", "").lower() for effect in obj.get("effects", [])):
                    continue
                geometry = layer_geometry(state, size, sh)
                layers.append({"id":obj["id"], "name":name, **geometry,
                               "image":Image.new("RGBA",(8,8),"white"), "native_size":size[:2]})
                continue
            if image_path.startswith("models/util/"):
                continue
            model = assets.json(image_path)
            material = assets.json(model["material"])
            passes = material["passes"]
            p = passes[0]
            if len(passes) != 1 or p.get("shader", "").lower() not in {"genericimage", "genericimage2", "genericimage4"}:
                raise ConversionError("不是支持的单通道平面材质")
            texture = p["textures"][0]
            # 混合特效按权重叠加其他视频（如按时段切换的清晨、白天、黄昏画面）：权重过半的一路就是该状态的画面。
            for effect, spec in effects_for(obj, props):
                if effect == "blend" and not int(spec["combos"].get("BLENDMODE", 0)) and assets.is_video(texture):
                    weights = [float(spec["values"].get("multiply" + (str(i) if i > 1 else ""), 0) or 0) for i in range(1, len(spec["textures"]))]
                    if weights and max(weights) >= .5 and spec["textures"][weights.index(max(weights)) + 1]:
                        texture = spec["textures"][weights.index(max(weights)) + 1]
            if assets.is_video(texture):
                if stage is None:
                    raise ConversionError("视频图层需要输出资源目录")
                from 视频处理 import extract_texture_video, poster
                media = Path(media_root) if media_root else stage/"media"
                media.mkdir(parents=True,exist_ok=True)
                video = extract_texture_video(assets.texture_bytes(texture),media,texture)
                poster_file = media/(video.stem+".jpg")
                if not poster_file.is_file():poster(video,poster_file)
                with Image.open(poster_file) as source_image:image=source_image.convert("RGBA")
                size = vector(obj.get("size"),list(image.size))
                layers.append({"id":obj["id"],"name":name,**layer_geometry(state,size,sh),
                               "image":image,"native_size":size[:2],"videoSource":str(video)})
                continue
            is_atlas = assets.is_atlas(texture)
            image = atlas_frames(assets, texture, trim=False, first_only=True)[0] if is_atlas else assets.texture(texture, albedo=True)
            size = vector(obj.get("size"), list(image.size))
            geometry = layer_geometry(state, size, sh)
            image.thumbnail((int(config["纹理最长边"]),) * 2, Image.Resampling.BILINEAR if fast else Image.Resampling.LANCZOS)
            layers.append({"id": obj["id"], "name": name, **geometry, "image": image,
                           "native_size": size[:2], "atlas": texture if is_atlas else None,
                           "puppet": model.get("puppet"), "blend": p.get("blending", "normal")})
            for key in ("origin", "scale", "angles", "visible", "color", "alpha"):
                if isinstance(obj.get(key), dict) and obj[key].get("script"):
                    notes.append(f"{name}：{key} 的原脚本未运行，使用工程默认值。")
        except (KeyError, IndexError, TypeError, ValueError, OSError, struct.error) as exc:
            notes.append(f"{name}：未转换，{exc}。")
    if not layers:
        raise ConversionError("没有可转换的平面图层。" + "\n" + "\n".join(notes[:12]))
    return sw, sh, layers, notes, project.get("title", source.parent.name)


def load_config(path):
    c = dict(DEFAULTS)
    if path and path.exists():
        supplied = json.loads(path.read_text(encoding="utf-8-sig"))
        # 旧配置仍可读，顶部定位已改为时钟整组居中。
        supplied.pop("文字顶部位置", None)
        unknown = set(supplied) - set(c)
        if unknown:
            raise ConversionError("未知配置项：" + "、".join(sorted(unknown)))
        c.update(supplied)
    ranges = {"预览宽度": (240, 4096), "预览高度": (240, 4096), "画面缩放": (1., 2.5),
              "横向取景": (0., 1.), "纵向取景": (0., 1.), "避让左侧比例": (0., .65),
              "文字中心位置": (.25, .90),
              "感应幅度": (0., .045), "感应灵敏度": (.5, 15.), "平滑系数": (.01, 1.),
              "纵向感应比例": (0., 1.), "帧率": (15, 60), "纹理最长边": (512, 4096)}
    for key, (low, high) in ranges.items():
        x = c[key]
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or not low <= x <= high:
            raise ConversionError(f"配置「{key}」应在 {low} 到 {high} 之间。")
    for key in ("横向方向", "纵向方向"):
        if c[key] not in (-1, 1):
            raise ConversionError(f"配置「{key}」只能是 -1 或 1。")
    for key in ("预览宽度", "预览高度", "帧率", "纹理最长边"):
        if not isinstance(c[key], int):
            raise ConversionError(f"配置「{key}」应为整数。")
    if not isinstance(c["显示秒"], bool) or c["星期语言"] not in {"中文", "英文"}:
        raise ConversionError("显示秒应为布尔值，星期语言应为中文或英文。")
    color = c["文字颜色"]
    if not isinstance(color, str) or (color != "原主题" and not re.fullmatch(r"#[0-9a-fA-F]{6}", color)):
        raise ConversionError("文字颜色可填「原主题」或六位颜色，例如 #FFFFFF。")
    if c["文字中心位置"] < c["避让左侧比例"] + .15:
        raise ConversionError("文字中心位置太靠近摄像头避让区，请向右调整。")
    return c


def number(x):
    return f"{x:.7f}".rstrip("0").rstrip(".") or "0"


def time_weight(points, minute):
    for (start,left),(end,right) in zip(points,points[1:]):
        if minute<=end:return max(0,min(1,left+(right-left)*(minute-start)/(end-start)))
    return points[-1][1]


def time_weight_expression(points):
    # 用斜率增量表达折线，避免为每段重复嵌套条件判断。
    # 硬切换仅相隔 0.01 分钟，保留斜率精度才能对齐视频的 0.5 边界。
    def precise(value):return f"{value:.17f}".rstrip("0").rstrip(".") or "0"
    expression=precise(points[0][1])
    previous=0
    for (start,left),(end,right) in zip(points,points[1:]):
        slope=(right-left)/(end-start)
        change=slope-previous
        if change:
            expression+=("+" if change>0 else "-")+f"{precise(abs(change))}*max(0,(#hour24*60+#minute)-{precise(start)})"
        previous=slope
    return f"max(0,min(1,{expression}))"


def element(parent, tag, **attrs):
    return ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})


def xml_bytes(root):
    ET.indent(root)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def add_layer_animation(node, layer):
    sequence = layer.get("sequence")
    if sequence and len(sequence["frames"]) > 1:
        frames = sequence["frames"]
        if sequence.get("mode") == "tilt":
            first = Path(frames[0])
            node.set("src", first.with_name(first.stem.rsplit("_", 1)[0] + first.suffix).as_posix())
            node.set("srcid", f"round((#move_x+1)*{number((len(frames)-1)/2)})")
        else:
            duration = sequence["period"]
            times = sequence.get("times", [round(duration*i/len(frames)) for i in range(len(frames))])
            animation = element(node, "SourcesAnimation", loop="true")
            for file, at in zip(frames + frames[:1], times + [duration]):
                element(animation, "Source", x="0", y="0", src=file, time=at)
    if layer.get("travel"):
        animation = element(node, "PositionAnimation", loop="true")
        for at, (x, y) in sorted({t: (x, y) for t, x, y in layer["travel"]}.items()):
            element(animation, "Item", x=f"{number(x)}*#scene_scale", y=f"{number(y)}*#scene_scale", time=at)
    if layer.get("fade"):
        animation = element(node, "AlphaAnimation", loop="true")
        for at, alpha in sorted(dict(layer["fade"]).items()):
            element(animation, "Item", value=alpha, time=at)


def clock_geometry(config, layout, width, height):
    if config.get("时钟排版"):
        return width/2, height/2, min(width/976, height/596)
    left = width * config["避让左侧比例"]
    margin, half_width = layout["margin"], layout["half_width"]
    unit = min(width/976, height/596, (width-left-2*margin)/(2*half_width),
               (height-2*margin)/layout["height"])
    half = half_width * unit + margin
    center = min(width - half, max(left + half, width * config["文字中心位置"]))
    return center, height/2, unit


def add_clock(root, layout, config):
    from 背屏时钟 import digit_expression
    if config.get("时钟排版"):
        element(root, "Var", name="clock_unit", expression="min(#view_width/976,#view_height/596)")
        for row in layout["rows"]:
            if row.get("visible") is False: continue
            key = row["key"]
            x = f"#view_width*{number(row['nx'])}"
            if row.get("align") == "left": x += f"+{number(row['w']/2)}*#clock_unit"
            elif row.get("align") == "right": x += f"-{number(row['w']/2)}*#clock_unit"
            line = element(root, "Group", name=f"clock_{key}", x=x, y=f"#view_height*{number(row['ny'])}")
            align = {"h": f"{row['h']}*#clock_unit", "align": "center", "alignV": "center", "antiAlias": "true"}
            if key == "week":
                element(line, "Image", x="0", y="0", w=f"{row['w']}*#clock_unit",src="assets/clock_week.png",srcid="max(0,min(6,#day_of_week-1))",**align)
                continue
            for part in row["pieces"]:
                expression = digit_expression(part["digit"]) if "digit" in part else None
                if expression and row.get("hourFormat") == "12":
                    expression = expression.replace("#hour24", "ifelse(eq(#hour24%12,0),12,#hour24%12)")
                attrs = {"src":part["asset"]} if "asset" in part else {"src":f"assets/clock_{key}_num.png","srcid":expression}
                element(line,"Image",x=f"{number(part['x'])}*#clock_unit",y="0",w=f"{part['w']}*#clock_unit",**attrs,**align)
        return
    margin, half_width = layout["margin"], layout["half_width"]
    left = f"#view_width*{number(config['避让左侧比例'])}"
    width_fit = f"(#view_width-{left}-{2*margin})/{number(2*half_width)}"
    height_fit = f"(#view_height-{2*margin})/{number(layout['height'])}"
    unit = f"max(0,min(min(#view_width/976,#view_height/596),min({width_fit},{height_fit})))"
    element(root, "Var", name="clock_unit", expression=unit)
    half = f"{number(half_width)}*#clock_unit+{margin}"
    center = f"min(#view_width-({half}),max({left}+{half},#view_width*{number(config['文字中心位置'])}))"
    group = element(root, "Group", name="clock", x=center, y="#view_height/2")
    for row in layout["rows"]:
        key = row["key"]
        line = element(group, "Group", name=f"clock_{key}", x="0", y=f"{number(row['y'])}*#clock_unit")
        align = {"h": f"{row['h']}*#clock_unit", "align": "center", "alignV": "center", "antiAlias": "true"}
        if key == "week":
            element(line, "Image", x="0", y="0", w=f"{row['w']}*#clock_unit",
                    src="assets/clock_week.png", srcid="max(0,min(6,#day_of_week-1))", **align)
            continue
        for part in row["pieces"]:
            attrs = {"src": part["asset"]} if "asset" in part else {
                "src": f"assets/clock_{key}_num.png", "srcid": digit_expression(part["digit"])}
            element(line, "Image", x=f"{number(part['x'])}*#clock_unit", y="0",
                    w=f"{part['w']}*#clock_unit", **attrs, **align)


def make_manifest(sw, sh, layers, c, clock=None, background="#061633"):
    root = ET.Element("Widget", version="2", screenWidth=str(int(c.get("预览宽度",1080))), scaleByDensity="false",
                      frameRate=str(int(c["帧率"])), useVariableUpdater="DateTime.Second" if c["显示秒"] else "DateTime.Minute")
    binders = element(root, "VariableBinders")
    sensor = element(binders, "SensorBinder", type="gravity", rate="1")
    for axis, index in (("x", 0), ("y", 1)):
        element(sensor, "Variable", name="g_" + axis, index=index)
    trigger = element(sensor, "Trigger", condition="eq(#motion_ready,0)")
    for axis in ("x", "y"):
        element(trigger, "VariableCommand", name="center_" + axis, expression="#g_" + axis)
    element(trigger, "VariableCommand", name="motion_ready", expression="1")
    for name, exp in (("motion_ready", "0"), ("center_x", "0"), ("center_y", "0"), ("smooth_x", "0"), ("smooth_y", "0")):
        element(root, "Var", name=name, expression=exp, const="true")
    smooth = number(c["平滑系数"])
    for axis in ("x", "y"):
        direction = c["横向方向" if axis == "x" else "纵向方向"]
        target = f"max(-1,min(1,(#g_{axis}-#center_{axis})*{direction}/{number(c['感应灵敏度'])}))*#motion_ready"
        element(root, "Var", name="move_" + axis, expression=f"#smooth_{axis}+(({target})-#smooth_{axis})*{smooth}")
        # 用独立变量存储上一帧，避免变量自引用求值顺序造成歧义。
        v = element(root, "Var", name="smooth_" + axis + "_updater", expression="#move_" + axis, threshold="0")
        t = element(v, "Trigger")
        element(t, "VariableCommand", name="smooth_" + axis, expression="#move_" + axis)
    amp = number(c["感应幅度"])
    max_motion = max(x["motion"] for x in layers)
    extra_x = c["感应幅度"] * max_motion
    extra_y = extra_x * c["纵向感应比例"]
    # 超出最大位移的留边防止倾斜时露出场景边缘。
    scale_exp = f"max(#view_width*(1+2*{number(extra_x)})/{number(sw)},#view_height*(1+2*{number(extra_y)})/{number(sh)})*{number(c['画面缩放'])}"
    element(root, "Var", name="scene_scale", expression=scale_exp)
    element(root, "Var", name="scene_left", expression=f"min(-#view_width*{number(extra_x)},max(#view_width-{number(sw)}*#scene_scale+#view_width*{number(extra_x)},(#view_width-{number(sw)}*#scene_scale)*{number(c['横向取景'])}))")
    element(root, "Var", name="scene_top", expression=f"min(-#view_height*{number(extra_y)},max(#view_height-{number(sh)}*#scene_scale+#view_height*{number(extra_y)},(#view_height-{number(sh)}*#scene_scale)*{number(c['纵向取景'])}))")
    has_video=any(layer.get("video") for layer in layers)
    if has_video:root.set("transparentSurface","true")
    else:element(root, "Rectangle", w="#view_width", h="#view_height", fillColor=background)
    video_visibility={}
    for layer in layers:
        motion = number(layer["motion"])
        weight=time_weight_expression(layer["time"]) if "time" in layer else None
        if layer.get("video"):
            target="video_"+str(layer["id"])
            video=element(root,"Video",name=target,layerType="bottom",
                    x=f"#scene_left+{number(layer['x']-layer['w']/2)}*#scene_scale+#move_x*#view_width*{amp}*{motion}",
                    y=f"#scene_top+{number(layer['y']-layer['h']/2)}*#scene_scale+#move_y*#view_height*{amp}*{motion}*{number(c['纵向感应比例'])}",
                    w=f"{number(layer['w'])}*#scene_scale",h=f"{number(layer['h'])}*#scene_scale")
            if weight is not None:
                visibility=f"gt({weight},0.5)"
                video.set("visibility",visibility);video_visibility[target]=visibility
                # 只在跨过可见阈值时触发，渐变过程中不反复重启视频。
                variable=target+"_visible"
                trigger=element(element(root,"Var",name=variable,expression=visibility,threshold="0"),"Trigger")
                element(trigger,"VideoCommand",target=target,command="play",condition="#"+variable)
                element(trigger,"VideoCommand",target=target,command="pause",condition=f"eq(#{variable},0)")
            continue
        parent=element(root,"Group",name="time_"+str(layer["id"]),alpha=f"255*({weight})") if weight is not None else root
        image = element(parent, "Image", name="layer_" + str(layer["id"]), src=layer["asset"],
                x=f"#scene_left+{number(layer['x'])}*#scene_scale+#move_x*#view_width*{amp}*{motion}",
                y=f"#scene_top+{number(layer['y'])}*#scene_scale+#move_y*#view_height*{amp}*{motion}*{number(c['纵向感应比例'])}",
                w=f"{number(layer['w'])}*#scene_scale", h=f"{number(layer['h'])}*#scene_scale",
                align="center", alignV="center", rotation=number(layer["rotation"]),
                pivotX=f"{number(layer['w']/2)}*#scene_scale", pivotY=f"{number(layer['h']/2)}*#scene_scale")
        add_layer_animation(image, layer)
    if clock is not None:
        add_clock(root, clock, c)
    # 点击可见区域重新居中；不绘制按钮文字，画面保持简洁。
    button = element(root, "Button", x=f"#view_width*{number(c['避让左侧比例'])}", y="0", w=f"#view_width*{number(1-c['避让左侧比例'])}", h="#view_height", interceptTouch="false")
    bt = element(element(button, "Triggers"), "Trigger", action="up")
    for axis in ("x", "y"):
        element(bt, "VariableCommand", name="center_" + axis, expression="#g_" + axis)
        element(bt, "VariableCommand", name="smooth_" + axis, expression="0")
    element(bt, "VariableCommand", name="motion_ready", expression="1")
    external = element(root, "ExternalCommands")
    if has_video:
        init=element(external,"Trigger",action="init")
        for layer in layers:
            if layer.get("video"):
                element(init,"VideoCommand",target="video_"+str(layer["id"]),command="config",path="'"+layer["video"]+"'",loop="1",scaleMode="2")
    resume = element(external, "Trigger", action="resume")
    element(resume, "VariableCommand", name="motion_ready", expression="0")
    for axis in ("x", "y"):
        element(resume, "VariableCommand", name="smooth_" + axis, expression="0")
    if has_video:
        pause=element(external,"Trigger",action="pause")
        for layer in layers:
            if layer.get("video"):
                target="video_"+str(layer["id"])
                condition={"condition":video_visibility[target]} if target in video_visibility else {}
                element(resume,"VideoCommand",target=target,command="play",**condition)
                element(resume,"VideoCommand",target=target,command="setVolume",volume=number(c.get("视频音量",0)))
                element(pause,"VideoCommand",target=target,command="pause")
    return xml_bytes(root)


def geometry(sw, sh, layers, c, width, height, dx=0, dy=0):
    maximum = max(x["motion"] for x in layers)
    ax = c["感应幅度"] * maximum
    ay = ax * c["纵向感应比例"]
    scale = max(width * (1 + 2 * ax) / sw, height * (1 + 2 * ay) / sh) * c["画面缩放"]
    left = min(-width * ax, max(width - sw * scale + width * ax, (width - sw * scale) * c["横向取景"]))
    top = min(-height * ay, max(height - sh * scale + height * ay, (height - sh * scale) * c["纵向取景"]))
    return [{"x": left + x["x"] * scale + dx * width * c["感应幅度"] * x["motion"],
             "y": top + x["y"] * scale + dy * height * c["感应幅度"] * x["motion"] * c["纵向感应比例"],
             "w": x["w"] * scale, "h": x["h"] * scale} for x in layers]


def still_preview(sw, sh, layers, c, clock=None, stage=None, background="#061633"):
    w, h = int(c["预览宽度"]), int(c["预览高度"])
    canvas = Image.new("RGBA", (w, h), background)
    now=datetime.now();minute=now.hour*60+now.minute
    for layer, box in zip(layers, geometry(sw, sh, layers, c, w, h)):
        if "image" not in layer:
            continue
        im=layer["image"]
        if "time" in layer:
            weight=time_weight(layer["time"],minute)
            if weight<=1e-6:continue
            im=im.copy()
            im.putalpha(im.getchannel("A").point(lambda alpha:round(alpha*weight)))
        angle=math.radians(layer["rotation"])
        co,si=math.cos(angle),math.sin(angle)
        sx,sy=im.width/box["w"],im.height/box["h"]
        x,y=box["x"],box["y"]
        # 直接采样可见画幅，避免放大屏幕外的整张纹理。
        matrix=(co*sx,si*sx,im.width/2-(x*co+y*si)*sx,
                -si*sy,co*sy,im.height/2+(x*si-y*co)*sy)
        canvas.alpha_composite(im.transform((w,h),Image.Transform.AFFINE,matrix,Image.Resampling.BICUBIC))
    if clock is not None:
        from 背屏时钟 import draw_clock
        x, y, unit = clock_geometry(c, clock, w, h)
        draw_clock(canvas, stage, clock, x, y, unit)
    return canvas.convert("RGB")


def choose_source():
    try:
        import tkinter as tk
        from tkinter import filedialog
        window = tk.Tk()
        window.withdraw()
        result = filedialog.askopenfilename(title="选择壁纸资源或图片", filetypes=[("壁纸资源或图片", "*.pkg *.json *.png *.jpg *.jpeg *.webp *.gif *.bmp"), ("全部文件", "*.*")])
        window.destroy()
        return Path(result) if result else None
    except Exception:
        raise ConversionError("无法打开文件选择器，请把资源文件或文件夹拖到一键转换启动器上，或在命令中传入路径。")


def project_entry(source):
    if source.is_dir() or source.name.lower()=="project.json":
        folder=source if source.is_dir() else source.parent
        project=folder/"project.json"
        if project.is_file():
            data=json.loads(project.read_text(encoding="utf-8-sig"))
            if str(data.get("type","scene")).lower()!="scene":
                raise ConversionError("此类壁纸工程暂未支持，请选择场景工程或图片。")
            chosen=data.get("file")
        else:
            chosen=None
        candidates=[folder/"scene.pkg"]
        if isinstance(chosen,str) and chosen:
            path=(folder/safe_name(chosen)).resolve()
            if path.is_relative_to(folder.resolve()):
                candidates.append(path)
        candidates.append(folder/"scene.json")
        for path in candidates:
            if path.is_file():
                return path
        raise ConversionError("工程目录中找不到场景资源。")
    return source


def picture_layers(source, stage, config):
    from 场景动效 import SceneAssets
    with Image.open(source) as file:
        base=bounded_image(file)
        width,height=base.size
        layer={"id":1,"name":"原图","x":width/2,"y":height/2,"w":width,"h":height,
               "motion":1.,"rotation":0.,"image":base}
        count=getattr(file,"n_frames",1)
        if count<=1:
            base.thumbnail((config["纹理最长边"],)*2, Image.Resampling.LANCZOS)
            layer["asset"]="assets/image.png"
            base.save(stage/layer["asset"],optimize=True)
            return width,height,[layer],[]
        if count>300:
            raise ConversionError("动画图片超过 300 帧，请截取较短的循环。")
        writer=SceneAssets(SceneFolder(source),stage,decode_tex)
        times=[]
        elapsed=0
        longest=min(840,config["纹理最长边"])

        def frames():
            nonlocal elapsed
            for i in range(count):
                file.seek(i)
                frame=file.convert("RGBA")
                frame.thumbnail((longest,longest),Image.Resampling.LANCZOS)
                times.append(elapsed)
                elapsed+=max(20,int(file.info.get("duration",100)))
                yield frame
        sequence=writer.sequence("image_motion",frames(),count)
        sequence.update({"period":elapsed,"times":times})
        layer["sequence"]=sequence
        layer["asset"]=sequence["frames"][0]
        return width,height,[layer],["图片帧动画"]


def write_product(stage, sw, sh, layers, config, name, restored, notes, details, source_type, clock=None, background="#061633"):
    manifest=make_manifest(sw,sh,layers,config,clock,background)
    (stage/"manifest.xml").write_bytes(manifest)
    title=name+(" · 动效背屏" if restored else " · 感应背屏")
    description="支持分层视差和点击居中。"
    if clock is not None:
        description="自定义星期、日期和时间排版。"+description
    if restored:
        description+=" 动效包括"+ "、".join(restored[:10])+"。"
    author=config["署名"] or "本地背屏适配"
    meta={"titles":{"fallback":title,"zh_CN":title},
          "descriptions":{"fallback":description,"zh_CN":description},
          "authors":{"fallback":author},"designers":{"fallback":author},
          "subResourceType":"REAREye","resSubType":"reareye_import","isRearScreenEditable":False,
          "isThirdParties":True,"supportAon":False}
    (stage/"metadata.mrm").write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8")
    desc=ET.Element("MIUI_Theme_Values")
    for key,text in (("title",title),("description",description),("author",author),("designer",author),("version","1")):
        element(desc,key).text=text
    (stage/"description.xml").write_bytes(xml_bytes(desc))
    cover=ET.Element("WidgetConfig")
    field=element(cover,"ImageSelect",name="rear_cover",displayTitle="封面预览",width="300",height="183")
    element(field,"item").text="preview.jpg"
    (stage/"var_config.xml").write_bytes(xml_bytes(cover))
    preview=still_preview(sw,sh,layers,config,clock,stage,background)
    preview.save(stage/"画面预览.jpg",quality=92)
    preview.save(stage/"preview.jpg",quality=90)
    clean_layers=[{k:v for k,v in layer.items() if k not in {"image","native_size","atlas","puppet"}} for layer in layers]
    payload={"width":sw,"height":sh,"title":name,"config":config,"clock":clock,
             "restored":restored,"layers":clean_layers,"background":background}
    template=(ROOT/"预览模板.html").read_text(encoding="utf-8")
    encoded=json.dumps(payload,ensure_ascii=False,allow_nan=False).replace("<","\\u003c")
    (stage/"交互预览.html").write_text(template.replace("__SCENE_DATA__",encoded),encoding="utf-8")
    report={"壁纸":name,"输入类型":source_type,"结果":"已生成，未做手机验收","图层数量":len(layers),
            "恢复效果":restored,"效果详情":details,"未迁移及注意事项":list(dict.fromkeys(notes)),
            "目标":"小米 18 Pro Max，RearEye 导入包","时钟":"按编辑器排版" if clock else "未添加",
            "字体来源":clock["fonts"] if clock else {}, "配置":config}
    (stage/"转换报告.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    (stage/"配置.json").write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding="utf-8")
    filename=re.sub(r'[<>:"/\\|?*\x00-\x1f]',"_",name).strip(". ")[:80] or "壁纸"
    package=stage/(filename+"_背屏.mrc")
    with zipfile.ZipFile(package,"w",zipfile.ZIP_DEFLATED) as z:
        for file in sorted((stage/"assets").iterdir()):
            if file.is_file():
                z.write(file,file.relative_to(stage).as_posix())
        for file in ("manifest.xml","metadata.mrm","description.xml","var_config.xml","preview.jpg"):
            z.write(stage/file,file)
    if package.stat().st_size>200*1024*1024:
        raise ConversionError("生成包超过 RearEye 的导入大小上限。")
    with zipfile.ZipFile(package) as z:
        tree=ET.fromstring(z.read("manifest.xml"))
        entries=set(z.namelist())
        referenced={layer["asset"] for layer in layers}
        for layer in layers:
            referenced.update(layer.get("sequence",{}).get("frames",[]))
        if clock:
            referenced.update(clock["assets"])
        if z.testzip() is not None or tree.tag!="Widget" or not referenced<=entries:
            raise ConversionError("生成包的完整性检查未通过。")
    return package,report


def convert(source, destination, config, title=None, font_overrides=None, no_clock=False):
    source=project_entry(source)
    if not source.is_file():
        raise ConversionError("找不到原文件："+str(source))
    if destination.exists():
        raise ConversionError("输出目录已存在。请选择新目录："+str(destination))
    suffix=source.suffix.lower()
    scene_input=suffix in {".pkg",".json"}
    if not scene_input and suffix not in {".png",".jpg",".jpeg",".webp",".gif",".bmp"}:
        raise ConversionError("请选择场景包、场景文件或图片。")
    destination.parent.mkdir(parents=True,exist_ok=True)
    # 临时目录中的完整成品通过校验后才交付。
    with tempfile.TemporaryDirectory(prefix=".背屏转换-",dir=destination.parent) as temp:
        from 背屏时钟 import build_clock, select_fonts
        stage=Path(temp)/"成品"
        (stage/"assets").mkdir(parents=True)
        notes=[]
        config=dict(config)
        clock=None
        if scene_input:
            from 场景动效 import build_motion_scene
            data=read_scene(source)
            pkg,project,scene,sw,sh,props=data
            worlds=world_transforms(scene["objects"],props,sw,sh,notes)
            if not no_clock:
                fonts=select_fonts(pkg,scene["objects"],worlds,props,font_overrides)
                clock=build_clock(stage,config,fonts)
                for _, font_record in fonts.values():
                    if font_record["选取规则"] in {"该行的可见源时钟图层", "用户明确指定"}:
                        for layer in font_record["源图层"]:
                            worlds[layer["编号"]] = None
            _,_,layers,layer_notes,name=scene_layers(source,config,data,worlds)
            notes.extend(layer_notes)
            config["署名"]=config["署名"] or str(project.get("author") or "")
            layers,restored,details=build_motion_scene(pkg,scene,props,layers,worlds,stage,decode_tex,layer_geometry,notes)
            source_type=getattr(pkg,"version","解包场景")
            background=scene_background(scene)
        else:
            if not no_clock:
                fonts=select_fonts(None,[],{},{},font_overrides)
                clock=build_clock(stage,config,fonts)
            sw,sh,layers,restored=picture_layers(source,stage,config)
            name,details,source_type=source.stem,{},suffix.lstrip(".").upper()
            notes.append("图片输入使用整体感应平移。")
            background="#061633"
        package,report=write_product(stage,sw,sh,layers,config,str(title or name),restored,notes,details,source_type,clock,background)
        os.replace(stage,destination)
    return destination/package.name,report


def main(argv=None):
    parser = argparse.ArgumentParser(description="将场景工程或图片转成带时钟与感应镜头的 RearEye 背屏包。")
    parser.add_argument("source", nargs="?", help="场景包、解包场景、创意工坊文件夹或图片")
    parser.add_argument("--config", type=Path, default=ROOT / "配置.json", help="中文配置文件")
    parser.add_argument("--output", type=Path, help="新建的成品目录，不能与旧目录重名")
    parser.add_argument("--title", help="自定义壁纸名称")
    font_group=parser.add_mutually_exclusive_group()
    font_group.add_argument("--font", action="append", default=[], help="明确指定字体文件，可用「日期=字体文件」等逐行指定")
    font_group.add_argument("--no-clock", action="store_true", help="仅转换画面和动效")
    args = parser.parse_args(argv)
    try:
        from 背屏时钟 import parse_font_options
        c = load_config(args.config)
        source = Path(args.source).expanduser().resolve() if args.source else choose_source()
        if source is None:
            print("已取消，未生成文件。")
            return 0
        name = source.name if source.is_dir() else (source.parent.name if source.name == "scene.pkg" else source.stem)
        from datetime import datetime
        dest = args.output or ROOT / "生成结果" / (name + "_" + datetime.now().strftime("%Y%m%d_%H%M%S_%f"))
        fonts = parse_font_options(args.font)
        package, report = convert(source, dest.resolve(), c, args.title, fonts, args.no_clock)
        print("已生成：" + str(package))
        print("预览：" + str(package.parent / "交互预览.html"))
        print(f"已生成 {report['图层数量']} 个图层。")
        if report["字体来源"]:
            for role, record in report["字体来源"].items():
                print(f"{role}字体  {record['字体内名']}  {record['字体文件']}")
        print("把 .mrc 文件发到手机，在 RearEye 的壁纸管理器中导入并应用。")
        if report.get("恢复效果"):
            print("已转换动效："+"、".join(report["恢复效果"]))
        print("转换范围见成品目录的转换报告.json。")
        print("当前完成离线产包与检查，手机上的导入和感应效果仍需实机验证。")
        return 0
    except (ImportError, OSError, ValueError, TypeError, KeyError, struct.error) as exc:
        print("转换未完成：" + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
