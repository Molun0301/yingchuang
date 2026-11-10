"""按背屏取景压缩已生成的图层资源，坐标与背屏清单保持一致。"""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import math
from pathlib import Path
import re
import subprocess
import tempfile

import imageio_ffmpeg
from PIL import Image
from 硬件编码 import encoder_args


VIDEO_BUDGET = 180 * 1024 * 1024
QUALITY = {"compact": (.75, 78, 28), "standard": (1., 86, 24), "high": (1.5, 92, 20)}


def _assets_size(stage):
    return sum(p.stat().st_size for p in (stage / "assets").rglob("*") if p.is_file())


def _groups(layers):
    # 同一序列的封面只计一次引用；跨图层共用任何一帧都不能单独裁切。
    paths = [set([layer["asset"], *layer.get("sequence", {}).get("frames", []),
                  *([layer["video"]] if layer.get("video") else [])]) for layer in layers]
    owners = defaultdict(set)
    for index, files in enumerate(paths):
        for path in files:
            owners[path].add(index)
    remaining = set(range(len(layers)))
    while remaining:
        pending = [remaining.pop()]
        members, files = set(), set()
        while pending:
            index = pending.pop()
            members.add(index)
            for path in paths[index] - files:
                files.add(path)
                neighbors = owners[path] & remaining
                remaining.difference_update(neighbors)
                pending.extend(neighbors)
        yield members, files


def _video_info(path):
    # 只复制包到空输出，同时取得时长、原尺寸及音轨大小，不解码整幅视频。
    result = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-nostdin", "-nostats", "-i", str(path),
         "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-f", "null", "-"],
        check=True, capture_output=True, text=True)
    header = result.stderr.split("Output #", 1)[0]
    video = next(line for line in header.splitlines() if "Video:" in line)
    size = tuple(map(int, re.search(r", (\d+)x(\d+)[ ,\[]", video).groups()))
    hours, minutes, seconds = map(float, re.search(r"Duration: (\d+):(\d+):([\d.]+)", header).groups())
    audio = float(re.search(r"\baudio:([\d.]+)(?:KiB|kB)", result.stderr)[1])
    # ffmpeg 的汇总按 KiB 舍入，向上留出一单位，避免复制音轨挤占视频预算。
    return {"size": size, "duration": hours * 3600 + minutes * 60 + seconds,
            "audio": math.ceil(audio + 1) * 1024 if audio else 0}


def _crop(layer, visible, size, unit):
    x0, y0 = layer["x"] - layer["w"] / 2, layer["y"] - layer["h"] / 2
    x1, y1 = max(x0, visible[0]), max(y0, visible[1])
    x2, y2 = min(x0 + layer["w"], visible[2]), min(y0 + layer["h"], visible[3])
    if x2 <= x1 or y2 <= y1:
        return None
    iw, ih = size
    # 向外取整保留边缘像素；视频按偶数取样，封面沿用同一归一化区域。
    a = max(0, math.floor((x1 - x0) / layer["w"] * iw / unit) * unit)
    b = max(0, math.floor((y1 - y0) / layer["h"] * ih / unit) * unit)
    c = min(iw, math.ceil((x2 - x0) / layer["w"] * iw / unit) * unit)
    d = min(ih, math.ceil((y2 - y0) / layer["h"] * ih / unit) * unit)
    box = a / iw, b / ih, c / iw, d / ih
    layer.update(x=x0 + (box[0] + box[2]) * layer["w"] / 2,
                 y=y0 + (box[1] + box[3]) * layer["h"] / 2,
                 w=(box[2] - box[0]) * layer["w"], h=(box[3] - box[1]) * layer["h"])
    return box


def _output_size(current, target, even=False):
    shrink = any(a > b * 1.05 for a, b in zip(current, target))
    size = tuple(max(2, min(int(a + .5), b) if shrink else int(a + .5)) for a, b in zip(current, target))
    if even:
        size = tuple(max(2, n // 2 * 2) for n in size)
    return size, any(n < a - .5 for n, a in zip(size, current))


def _save_image(image, path, kind, quality):
    if kind == "JPEG":
        image.convert("RGB").save(path, format=kind, quality=quality)
    elif kind == "PNG":
        image.save(path, format=kind, optimize=True)
    else:
        image.save(path, format="WEBP", quality=quality, method=4)


def _fit_images(stage, paths, crop, target, quality):
    sizes = []
    for name in paths:
        with Image.open(stage / name) as image:
            sizes.append(image.size)
    if crop is None:
        size, shrunk = (2, 2), False
    else:
        current = (min(w for w, h in sizes) * (crop[2] - crop[0]),
                   min(h for w, h in sizes) * (crop[3] - crop[1]))
        size, shrunk = _output_size(current, target)
        shrunk = any(size[0] < w * (crop[2] - crop[0]) - .5 or size[1] < h * (crop[3] - crop[1]) - .5
                     for w, h in sizes)
    for name, original in zip(paths, sizes):
        if crop == (0, 0, 1, 1) and original == size:
            continue
        with Image.open(stage / name) as source:
            kind = source.format
            if crop is None:
                image = Image.new("RGBA", (2, 2))
            else:
                w, h = source.size
                image = source.convert("RGBA").resize(size, Image.Resampling.LANCZOS,
                                                     box=(crop[0] * w, crop[1] * h, crop[2] * w, crop[3] * h))
        _save_image(image, stage / name, kind, quality)
    return shrunk


def _fit_video(path, info, crop, target, crf, budget):
    iw, ih = info["size"]
    if crop is None:
        box = (0, 0, 2, 2)
    else:
        box = tuple(round(n * extent) for n, extent in zip(crop, (iw, ih, iw, ih)))
    a, b, c, d = box
    size, shrunk = _output_size((c - a, d - b), target, even=True)
    if box == (0, 0, iw, ih) and size == (iw, ih) and path.stat().st_size <= budget:
        return False
    # 给封装预留空间，并把两秒缓冲突发计入上限，短视频也不透支份额。
    rate = int((budget - max(8192, budget * .02) - info["audio"]) * 8 / (info["duration"] + 2))
    filters = f"crop={c-a}:{d-b}:{a}:{b},scale={size[0]}:{size[1]}:flags=lanczos,setsar=1"
    with tempfile.NamedTemporaryFile(prefix="画质压缩-", suffix=".mp4", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-i", str(path), "-map", "0:v:0", "-map", "0:a?", "-vf", filters,
             *encoder_args(quality=crf), "-pix_fmt", "yuv420p",
             "-maxrate", str(rate), "-bufsize", str(rate * 2), "-c:a", "copy", "-movflags", "+faststart",
             str(temporary)], check=True, capture_output=True)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return shrunk


def fit_layers(stage, layers, config, sw, sh) -> dict:
    """就地压缩 assets 和图层几何；统计包含 assets 内未引用的文件。"""
    before = _assets_size(stage)
    density, quality, crf = QUALITY[config.get("导出画质", "standard")]
    width, height = config["预览宽度"], config["预览高度"]
    amp, vertical = config["感应幅度"], config["纵向感应比例"]
    ax = amp * max(layer["motion"] for layer in layers)
    ay = ax * vertical
    scale = max(width * (1 + 2 * ax) / sw, height * (1 + 2 * ay) / sh) * config["画面缩放"]
    left = min(-width * ax, max(width - sw * scale + width * ax, (width - sw * scale) * config["横向取景"]))
    top = min(-height * ay, max(height - sh * scale + height * ay, (height - sh * scale) * config["纵向取景"]))
    names = sorted({layer["video"] for layer in layers if layer.get("video")})
    with ThreadPoolExecutor(max_workers=4) as pool:
        videos = dict(zip(names, pool.map(lambda name: _video_info(stage / name), names)))
    cropped, shrunk, jobs = set(), set(), []
    for members, files in _groups(layers):
        images = sorted(files - videos.keys())
        video_paths = sorted(files & videos.keys())
        crop = (0, 0, 1, 1)
        if len(members) == 1:
            index = next(iter(members))
            layer = layers[index]
            if abs(layer["rotation"]) < .01:
                mx, my = width * (amp * layer["motion"] + .02), height * (amp * layer["motion"] * vertical + .02)
                visible = ((-left - mx) / scale, (-top - my) / scale,
                           (width - left + mx) / scale, (height - top + my) / scale)
                if video_paths:
                    size = videos[video_paths[0]]["size"]
                else:
                    with Image.open(stage / layer["asset"]) as image:
                        size = image.size
                crop = _crop(layer, visible, size, 2 if video_paths else 1)
                if crop != (0, 0, 1, 1):
                    cropped.add(index)
        target = tuple(max(2, int(max(layers[i][key] for i in members) * scale * density + .5)) for key in ("w", "h"))
        if _fit_images(stage, images, crop, target, quality):
            shrunk.update(members)
        jobs.extend((name, crop, target, members) for name in video_paths)
    # 图片压缩完成后再分配预算，未引用的视频也作为其他资源计入包体。
    other = _assets_size(stage) - sum((stage / name).stat().st_size for name in videos)
    duration = sum(info["duration"] for info in videos.values())
    # 各视频的预算互不影响，转码进程并行运行。
    with ThreadPoolExecutor(max_workers=4) as pool:
        fitted = list(pool.map(lambda job: _fit_video(stage / job[0], videos[job[0]], job[1], job[2], crf,
                                                      (VIDEO_BUDGET - other) * videos[job[0]]["duration"] / duration), jobs))
    for (name, crop, target, members), changed in zip(jobs, fitted):
        if changed:
            shrunk.update(members)
    after = _assets_size(stage)
    return {"处理前字节": before, "处理后字节": after, "图层数": len(layers),
            "裁切图层": len(cropped), "缩小图层": len(shrunk), "视频": len(videos)}
