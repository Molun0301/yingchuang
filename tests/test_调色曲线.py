"""用独立色块和几何关键点验证调色、时段曲线及实际视频转码。"""
from copy import deepcopy
import gzip
import json
import math
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

import imageio_ffmpeg
import numpy as np
from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))
import 应用桥接 as bridge
import 背屏转换 as converter
import 画质压缩 as compression
from 调色查表 import apply_luts
from test_时段变化 import time_request, image_layer, evaluate, write_json
from test_逐层烘焙 import scene_request, edit_scene, save_scene
from test_缺陷修复 import video_texture


def lut(function, size=3):
    return {"size": size, "table": [channel for b in np.linspace(0, 255, size)
                                   for g in np.linspace(0, 255, size)
                                   for r in np.linspace(0, 255, size) for channel in function(r, g, b)]}


def test_identity_lut_preserves_straight_rgba_exactly():
    pixels = np.random.default_rng(22).integers(0, 256, (17, 19, 4), dtype=np.uint8)
    image = Image.fromarray(pixels)
    assert np.array_equal(apply_luts(image, [lut(lambda r, g, b: (r, g, b))]), pixels)


def test_trilinear_lut_uses_rgb_axes_and_preserves_transparent_pixels():
    pixels = np.array([[[80, 120, 160, 128], [29, 63, 207, 0], [12, 240, 74, 255]]], dtype=np.uint8)
    result = np.asarray(apply_luts(Image.fromarray(pixels), [lut(lambda r, g, b: (g, b, r * g / 255))]))
    assert result.tolist() == [[[120, 160, 38, 128], [29, 63, 207, 0], [240, 74, 11, 255]]]
    assert np.array_equal(pixels[..., 3], result[..., 3])


def test_luts_apply_in_supplied_order():
    image = Image.new("RGBA", (1, 1), (30, 70, 110, 64))
    invert = lut(lambda r, g, b: (255 - r, g, b))
    swap = lut(lambda r, g, b: (b, r, g))
    assert apply_luts(image, [invert, swap]).getpixel((0, 0)) == (110, 225, 70, 64)
    assert apply_luts(image, [swap, invert]).getpixel((0, 0)) == (145, 30, 70, 64)


@pytest.mark.parametrize("points", [
    [[0, -36], [360, 12], [720, -18], [1440, 90]],
    [[0, .3], [360, 2.5], [720, .7], [1440, 1.6]],
])
def test_unclamped_expression_matches_knots_and_intermediate_minutes(points):
    expression = converter.time_curve_expression(points)
    for minute, value in points:
        assert evaluate(expression, minute) == pytest.approx(value)
    for minute, value in [(180, (points[0][1] + points[1][1]) / 2),
                          (540, (points[1][1] + points[2][1]) / 2),
                          (1080, (points[2][1] + points[3][1]) / 2)]:
        assert evaluate(expression, minute) == pytest.approx(value)


def test_inspect_follows_material_and_effect_shaders_in_scene_and_engine(scene_request, tmp_path):
    source = Path(scene_request["theme"]["source"]).parent
    engine = tmp_path / "引擎资源"
    scene_request["theme"]["engineRoots"] = [str(engine)]
    write_json(source / "materials/picture.json", {"passes": [{"shader": "static"}, {"shader": "daily"}]})
    (source / "shaders").mkdir()
    (source / "shaders/daily.vert").write_text("uniform float g_Daytime;", encoding="utf-8")
    write_json(engine / "effects/bloom/effect.json", {"passes": [{"material": "materials/daily-effect.json"}]})
    write_json(engine / "materials/daily-effect.json", {"passes": [{"shader": "daily-effect"}]})
    (engine / "shaders").mkdir()
    (engine / "shaders/daily-effect.frag").write_text("uniform float g_Daytime;", encoding="utf-8")
    scene = edit_scene(scene_request)
    scene["objects"] += [{"id": 5, "image": "models/util/solidlayer.json", "colorBlendMode": 2},
                         {"id": 6, "image": "models/util/fullscreenlayer.json", "effects": [{"file": "effects/clouds/effect.json"}]}]
    save_scene(scene_request, scene)
    result = bridge.inspect_theme(scene_request)
    assert result["adjustLayerIds"] == [3, 5]
    assert result["daytimeLayerIds"] == [1, 2, 3]


def test_plan_solid_adjustment_includes_native_video_and_preserves_merging(scene_request):
    source = Path(scene_request["theme"]["source"]).parent
    (source / "materials/video.tex").write_bytes(video_texture(b"\0\0\0\x18ftypmp42" + b"\0" * 32, 4))
    write_json(source / "models/video.json", {"material": "materials/video.json"})
    write_json(source / "materials/video.json", {"passes": [{"textures": ["video.tex"]}]})
    scene = edit_scene(scene_request)
    scene["objects"].insert(1, {"id": 8, "image": "models/util/projectlayer.json", "effects": [{"file": "effects/blur/effect.json"}]})
    scene["objects"].insert(3, {"id": 9, "image": "models/video.json"})
    scene["objects"].append({"id": 10, "image": "models/util/solidlayer.json", "colorBlendMode": 1})
    save_scene(scene_request, scene)
    plan = bridge.layer_plan(scene_request)
    assert plan["targets"][0]["members"] == [1]
    assert [target["id"] for target in plan["targets"]] == [8, 2]
    assert plan["adjust"] == [{"id": 3, "kind": "compose", "below": [8, 2, 9]}, {"id": 10, "kind": "blend", "below": [8, 2, 9]}]
    assert plan["unsupported"] == []



def test_plan_bakes_video_with_transparency_effect_and_keeps_plain_video_for_phone(scene_request):
    """背屏视频没有透明通道：带抠色效果的视频交给渲染器逐层渲染，普通视频与带其他特效的视频仍由背屏播放。"""
    source = Path(scene_request["theme"]["source"]).parent
    (source / "materials/video.tex").write_bytes(video_texture(b"\0\0\0\x18ftypmp42" + b"\0" * 32, 4))
    write_json(source / "models/video.json", {"material": "materials/video.json"})
    write_json(source / "materials/video.json", {"passes": [{"textures": ["video.tex"]}]})
    scene = edit_scene(scene_request)
    scene["objects"] += [{"id": 11, "image": "models/video.json", "effects": [{"file": "effects/colorkey/effect.json"}]},
                         {"id": 12, "image": "models/video.json", "effects": [{"file": "effects/blend/effect.json"}]},
                         {"id": 13, "image": "models/video.json"}]
    save_scene(scene_request, scene)
    targets = [target["id"] for target in bridge.layer_plan(scene_request)["targets"]]
    assert 11 in targets and 12 not in targets and 13 not in targets

def curve_request(request, tmp_path, baked=True):
    request.pop("timeVariants")
    scene = deepcopy(request["theme"]["resolvedScene"])
    scene["objects"] = [{"id": 9, "origin": "10 10 0", "scale": "2 2 1", "angles": f"0 0 {math.pi / 2}"},
                        {"id": 1, "parent": 9, "origin": "2 3 0", "image": "models/picture.json", "size": "16 12"}]
    request["theme"]["resolvedScene"] = deepcopy(scene)
    # 当前场景与参考时刻不同，输出必须选参考场景中的状态。
    request["theme"]["resolvedScene"]["objects"][1]["origin"] = "20 30 0"
    record = None
    if baked:
        folder = tmp_path / "烘焙帧"; folder.mkdir()
        with gzip.open(folder / "frames.rgba.gz", "wb") as stream:
            stream.write(Image.new("RGBA", (4, 4), (80, 120, 160, 128)).tobytes())
        record = {"dir": str(folder), "width": 4, "height": 4, "count": 1, "fps": 30, "bbox": [6, 32, 4, 4]}
    request["timeVariants"] = {"scenes": [scene], "objects": {}, "curves": {"1": {
        "scene": 0, "baked": record, "alpha": [[0, 1], [720, .5], [1440, 1]],
        "origin": [[0, [2, 3, 0]], [720, [4, 3, 0]], [1440, [2, 3, 0]]],
        "scale": [[0, [1, 1, 1]], [720, [2, 2, 1]], [1440, [1, 1, 1]]],
        "angles": [[0, [0, 0, 0]], [720, [0, 0, math.pi / 2]], [1440, [0, 0, 0]]]}}}
    return request


@pytest.mark.parametrize("baked", [True, False])
def test_curves_use_reference_parent_and_fold_pivot_center_shift(time_request, tmp_path, baked):
    request = curve_request(time_request, tmp_path, baked)
    original = deepcopy(request)
    _, payload = bridge.prepare_graphics(request)
    [layer] = payload["layers"]
    assert request == original and layer["id"] == 1
    if baked:
        assert [layer[key] for key in ("x", "y", "w", "h")] == [8, 34, 4, 4]
        # 原中心距世界 origin 向右 4；父变换把局部位移变成向上 4，旋转缩放再使中心向上 8。
        expected = {"dx": -4, "dy": -12}
    else:
        assert [layer[key] for key in ("x", "y", "w", "h", "rotation")] == pytest.approx([4, 34, 32, 24, -90])
        expected = {"dx": 0, "dy": -4}
    expected.update(sx=2, sy=2, rot=-90, alpha=.5)
    for key, value in expected.items():
        assert dict(layer["curve"][key])[720] == pytest.approx(value)
    assert payload["details"]["时段变化"]["曲线数"] == 1


@pytest.mark.parametrize("kind", ["curve", "variant", "native"])
def test_luts_reach_baked_and_native_outputs_and_hide_adjustments(time_request, tmp_path, kind):
    request = curve_request(time_request, tmp_path, kind != "native")
    scenes = request["timeVariants"]["scenes"]
    for scene in [request["theme"]["resolvedScene"], *scenes]:
        scene["objects"] += [{"id": 3, "name": "全局调色", "image": "models/util/fullscreenlayer.json",
                              "effects": [{"file": "effects/color_grading/effect.json"}]},
                             {"id": 4, "name": "位置调色", "image": "models/util/solidlayer.json", "colorBlendMode": 2},
                             {"id": 171, "name": "可调整组合层", "image": "models/util/composelayer.json",
                              "effects": [{"file": "effects/color_grading/effect.json"}]}]
    keys = ["3@0", "3@720"]
    request["adjust"] = {"luts": {keys[0]: lut(lambda r, g, b: (255 - r, g, b)),
                                 keys[1]: lut(lambda r, g, b: (b, r, g))}, "layers": {}, "hidden": [4]}
    if kind == "variant":
        curve = request["timeVariants"]["curves"].pop("1")
        request["timeVariants"]["objects"]["1"] = [{"scene": 0, "alpha": [[0, 1], [1440, 1]], "baked": curve["baked"], "adjust": keys}]
    elif kind == "curve":request["timeVariants"]["curves"]["1"]["adjust"] = keys
    else:
        request.pop("timeVariants")
        request["adjust"]["layers"] = {"1": keys}
    original = deepcopy(request)
    root, payload = bridge.prepare_graphics(request)
    assert request == original and len(payload["layers"]) == 1
    [layer] = payload["layers"]
    with Image.open(root / layer["asset"]) as image:
        expected = (160, 175, 120, 128) if kind != "native" else (120, 203, 86, 255)
        assert image.convert("RGBA").getpixel((1, 1)) == pytest.approx(expected, abs=3)
    assert "_luts" not in layer
    assert any("位置调色 · 位置相关" in note for note in payload["notes"])
    assert any("全局调色 · 调色已通过查色表套用" in note for note in payload["notes"])
    assert "可调整组合层 · 合成层效果 color_grading 暂未转换" in payload["notes"]
    assert not any("可调整组合层 · 调色已通过查色表套用" in note for note in payload["notes"])


def test_curve_and_adjust_data_change_cache_identity(time_request, tmp_path):
    request = curve_request(time_request, tmp_path)
    args = (request["theme"], request["project"], None)
    variants = request["timeVariants"]
    original = bridge.graphic_key(*args, variants)
    for field in ("origin", "scale", "angles", "alpha", "adjust", "baked"):
        changed = deepcopy(variants)
        curve = changed["curves"]["1"]
        if field == "adjust":curve[field] = ["3@0"]
        elif field == "baked":curve[field]["bbox"][0] += 1
        elif field == "alpha":curve[field][0][1] = .2
        else:curve[field][0][1][0] += .2
        assert bridge.graphic_key(*args, changed) != original
    adjust = {"luts": {"3@0": lut(lambda r, g, b: (r, g, b))}, "layers": {"1": ["3@0"]}, "hidden": []}
    with_adjust = bridge.graphic_key(*args, variants, adjust)
    assert with_adjust != original
    adjust["luts"]["3@0"]["table"][0] += 1
    assert bridge.graphic_key(*args, variants, adjust) != with_adjust


@pytest.mark.parametrize("video", [False, True])
def test_manifest_curve_geometry_and_combined_alpha_at_key_minutes(video):
    curve = {"dx": [[0, -20], [720, 30], [1440, -20]], "dy": [[0, 10], [1440, -10]],
             "sx": [[0, 1], [1440, 2]], "sy": [[0, .5], [1440, 1.5]],
             "rot": [[0, -45], [1440, 90]], "alpha": [[0, .2], [1440, .8]]}
    layer = image_layer(curve=curve, time=[[0, .5], [1440, 1]], **({"video": "assets/video.mp4"} if video else {}))
    root = ET.fromstring(converter.make_manifest(64, 48, [layer], converter.DEFAULTS))
    node = root.find("Video") if video else root.find("Group/Image")
    # 视频按时段权重显示或隐藏（权重过半可见），图片按权重渐变。
    alpha = node.get("visibility") if video else root.find("Group").get("alpha")
    def value(expression, minute):
        for name, scalar in {"#scene_left": 3, "#scene_top": 7, "#scene_scale": 2,
                             "#move_x": .5, "#move_y": -.5, "#view_width": 320, "#view_height": 240}.items():
            expression = expression.replace(name, str(scalar))
        return evaluate(expression, minute)
    for minute in (0, 360, 720, 1080, 1440):
        f = minute / 1440
        dx = -20 + (50 * minute / 720 if minute <= 720 else 50 * (1440 - minute) / 720)
        w, h = 64 * (1 + f) * 2, 48 * (.5 + f) * 2
        x = 3 + (32 + dx) * 2 + .5 * 320 * converter.DEFAULTS["感应幅度"]
        y = 7 + (24 + 10 - 20 * f) * 2 - .5 * 240 * converter.DEFAULTS["感应幅度"] * converter.DEFAULTS["纵向感应比例"]
        assert value(node.get("x"), minute) == pytest.approx(x - w / 2 if video else x)
        assert value(node.get("y"), minute) == pytest.approx(y - h / 2 if video else y)
        assert value(node.get("w"), minute) == pytest.approx(w)
        assert value(node.get("h"), minute) == pytest.approx(h)
        assert value(node.get("rotation"), minute) == pytest.approx(-45 + 135 * f)
        weight = (.5 + .5 * f) * (.2 + .6 * f)
        assert value(alpha, minute) == (int(weight > .5) if video else pytest.approx(255 * weight))


def test_moving_layer_is_not_cropped_at_reference_time(tmp_path):
    (tmp_path / "assets").mkdir()
    Image.new("RGBA", (100, 100), "red").save(tmp_path / "assets/picture.png")
    curve = {"dx": [[0, 0], [1440, 80]], "sx": [[0, 1], [1440, 2]]}
    layers = [image_layer(x=50, y=50, w=100, h=100, curve=deepcopy(curve))]
    config = {**converter.DEFAULTS, "预览宽度": 100, "预览高度": 100, "画面缩放": 2}
    stats = compression.fit_layers(tmp_path, layers, config, 100, 100)
    assert stats["裁切图层"] == 0
    assert [layers[0][key] for key in ("x", "y", "w", "h")] == [50, 50, 100, 100]
    assert layers[0]["curve"] == curve


def test_embedded_video_luts_run_in_existing_transcode_and_survive_export(time_request, tmp_path):
    source_video = tmp_path / "原视频.mp4"
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-f", "lavfi", "-i",
                    "color=c=0x3c78b4:s=64x48:r=5:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source_video)], check=True)
    source = Path(time_request["theme"]["source"]).parent
    (source / "materials/video.tex").write_bytes(video_texture(source_video.read_bytes(), 4))
    write_json(source / "materials/picture.json", {"passes": [{"shader": "genericimage4", "textures": ["video.tex"]}]})
    scene = time_request["theme"]["resolvedScene"]
    scene["objects"] = [{"id": 1, "image": "models/picture.json", "origin": "32 24 0", "size": "64 48"}]
    time_request.pop("timeVariants")
    time_request["adjust"] = {"luts": {"3@0": lut(lambda r, g, b: (255 - r, g, b)),
                                      "4@0": lut(lambda r, g, b: (b, r, g))},
                              "layers": {"1": ["3@0", "4@0"]}, "hidden": []}
    result = bridge.export(time_request)
    root = Path(result["folder"])
    video = next((root / "assets").glob("*.mp4"))
    frames = imageio_ffmpeg.read_frames(str(video), pix_fmt="rgb24")
    try:
        info = next(frames)
        pixels = np.frombuffer(next(frames), dtype=np.uint8).reshape(info["size"][1], info["size"][0], 3)
    finally:frames.close()
    assert pixels.mean(axis=(0, 1)) == pytest.approx([180, 195, 120], abs=6)
    assert not list((root / "assets").glob("*.cube"))
