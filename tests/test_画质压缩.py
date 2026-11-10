"""独立生成资源，验证背屏取景、资源复用和视频体积预算。"""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import subprocess
import sys

import imageio_ffmpeg
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "core"))
import 画质压缩 as compression
from 背屏转换 import geometry


def config(**changes):
    return {"预览宽度": 976, "预览高度": 596, "画面缩放": 1., "横向取景": .5,
            "纵向取景": .5, "感应幅度": .02, "纵向感应比例": .3, **changes}


def layer(**changes):
    return {"x": 1920., "y": 1080., "w": 3840., "h": 2160., "rotation": 0.,
            "motion": 1., "asset": "assets/background.webp", **changes}


def dimensions(path):
    with Image.open(path) as image:
        return image.size


def video_info(path):
    frames = imageio_ffmpeg.read_frames(str(path))
    try:
        return next(frames)
    finally:
        frames.close()


@pytest.fixture(scope="module")
def background():
    # 带纹理的图片能区分不同密度和编码质量的实际体积。
    stream = BytesIO()
    Image.effect_noise((3840, 2160), 40).convert("RGB").save(stream, format="WEBP", quality=97, method=0)
    return stream.getvalue()


def stage_with_background(tmp_path, background):
    (tmp_path / "assets").mkdir(parents=True)
    (tmp_path / "assets/background.webp").write_bytes(background)
    return tmp_path


@pytest.mark.parametrize("focus", [0., .5, 1.])
def test_background_resolution_and_sensor_coverage(tmp_path, background, focus):
    stage = stage_with_background(tmp_path, background)
    layers = [layer()]
    c = config(横向取景=focus, 纵向取景=focus)
    stats = compression.fit_layers(stage, layers, c, 3840, 2160)
    box = geometry(3840, 2160, layers, c, 976, 596)[0]
    size = dimensions(stage / layers[0]["asset"])
    assert abs(size[0] - box["w"]) <= 2 and abs(size[1] - box["h"]) <= 2
    assert layers[0]["w"] < 3840 and layers[0]["h"] == pytest.approx(2160)
    assert stats == {"处理前字节": len(background), "处理后字节": (stage / layers[0]["asset"]).stat().st_size,
                     "图层数": 1, "裁切图层": 1, "缩小图层": 1, "视频": 0}
    for dx in (-1, 1):
        for dy in (-1, 1):
            tilted = geometry(3840, 2160, layers, c, 976, 596, dx, dy)[0]
            assert tilted["x"] - tilted["w"] / 2 <= 1e-7
            assert tilted["x"] + tilted["w"] / 2 >= 976 - 1e-7
            assert tilted["y"] - tilted["h"] / 2 <= 1e-7
            assert tilted["y"] + tilted["h"] / 2 >= 596 - 1e-7
    # 取景未抵达原图边缘的一侧，还应包含额外 2% 安全边。
    if focus <= .5:
        assert box["x"] + box["w"] / 2 >= 976 * 1.04
    if focus >= .5:
        assert box["x"] - box["w"] / 2 <= -976 * .04


def test_zoom_crops_before_resizing_and_preserves_scene_position(tmp_path, background):
    stage = stage_with_background(tmp_path, background)
    layers = [layer()]
    c = config(画面缩放=2., 横向取景=.2, 纵向取景=.8)
    original = geometry(3840, 2160, layers, c, 976, 596)[0]
    compression.fit_layers(stage, layers, c, 3840, 2160)
    fitted = layers[0]
    box = geometry(3840, 2160, layers, c, 976, 596)[0]
    assert fitted["w"] < 3840 * .51 and fitted["h"] < 2160 * .53
    assert dimensions(stage / fitted["asset"])[0] < original["w"] * .51
    # 比较同一个原图坐标在裁切前后的屏幕位置，不能只验证覆盖范围。
    u = (1920 - (fitted["x"] - fitted["w"] / 2)) / fitted["w"]
    assert box["x"] - box["w"] / 2 + u * box["w"] == pytest.approx(original["x"])


def test_shared_sprite_uses_largest_requirement_without_crop(tmp_path):
    (tmp_path / "assets").mkdir()
    Image.new("RGBA", (1024, 1024), (60, 100, 200, 128)).save(tmp_path / "assets/sprite.webp")
    layers = [layer(asset="assets/sprite.webp", x=-500, w=100, h=100, motion=.5),
              layer(asset="assets/sprite.webp", w=800, h=600, motion=2)]
    original = deepcopy(layers)
    c = config()
    boxes = geometry(3840, 2160, layers, c, 976, 596)
    stats = compression.fit_layers(tmp_path, layers, c, 3840, 2160)
    assert layers == original
    assert dimensions(tmp_path / "assets/sprite.webp") == (round(max(b["w"] for b in boxes)), round(max(b["h"] for b in boxes)))
    assert stats["裁切图层"] == 0 and stats["缩小图层"] == 2
    with Image.open(tmp_path / "assets/sprite.webp") as image:
        assert image.getchannel("A").getextrema() == (128, 128)


@pytest.mark.parametrize("angle", [.01, -30.])
def test_rotated_layer_only_resizes(tmp_path, background, angle):
    stage = stage_with_background(tmp_path, background)
    layers = [layer(rotation=angle)]
    original = deepcopy(layers)
    c = config(画面缩放=2.)
    box = geometry(3840, 2160, layers, c, 976, 596)[0]
    stats = compression.fit_layers(stage, layers, c, 3840, 2160)
    assert layers == original and stats["裁切图层"] == 0
    assert dimensions(stage / layers[0]["asset"]) == (round(box["w"]), round(box["h"]))


def test_sequence_frames_share_crop_size_and_keep_asset(tmp_path):
    (tmp_path / "assets").mkdir()
    names = [f"assets/frame_{i}.png" for i in range(3)]
    for i, name in enumerate(names):
        Image.new("RGBA", (1920, 1080), (20 + i * 30, 80, 140, 100)).save(tmp_path / name)
    sequence = {"frames": names, "period": 200, "mode": "tilt", "times": [0, 100, 200]}
    layers = [layer(asset=names[1], sequence=deepcopy(sequence))]
    stats = compression.fit_layers(tmp_path, layers, config(), 3840, 2160)
    assert layers[0]["sequence"] == sequence and (tmp_path / layers[0]["asset"]).is_file()
    assert len({dimensions(tmp_path / name) for name in names}) == 1
    assert dimensions(tmp_path / names[0])[0] < 1100
    assert stats["裁切图层"] == stats["缩小图层"] == 1
    for name in names:
        with Image.open(tmp_path / name) as image:
            assert image.format == "PNG" and image.getchannel("A").getextrema() == (100, 100)


@pytest.mark.parametrize("size", [(32, 24), (104, 104)])
def test_small_or_within_five_percent_image_is_untouched(tmp_path, size):
    (tmp_path / "assets").mkdir()
    path = tmp_path / "assets/small.webp"
    Image.new("RGBA", size, (30, 60, 90, 130)).save(path, quality=97)
    before = path.read_bytes()
    layers = [layer(asset="assets/small.webp", x=50, y=50, w=100, h=100)]
    c = config(预览宽度=100, 预览高度=100, 感应幅度=0)
    stats = compression.fit_layers(tmp_path, layers, c, 100, 100)
    assert path.read_bytes() == before
    assert stats["处理前字节"] == stats["处理后字节"] == len(before)
    assert stats["裁切图层"] == stats["缩小图层"] == 0


def test_quality_tiers_have_increasing_total_bytes(tmp_path, background):
    sizes = []
    for quality in ("compact", "standard", "high"):
        stage = stage_with_background(tmp_path / quality, background)
        (stage / "assets/未引用.bin").write_bytes(b"unused" * 100)
        (stage / "忽略.bin").write_bytes(b"outside assets")
        stats = compression.fit_layers(stage, [layer()], config(导出画质=quality), 3840, 2160)
        assert stats["处理前字节"] == len(background) + 600
        assert stats["处理后字节"] == sum(p.stat().st_size for p in (stage / "assets").iterdir())
        sizes.append(stats["处理后字节"])
    assert sizes[0] < sizes[1] < sizes[2]


def test_empty_intersection_keeps_transparent_layer_and_unknown_fields(tmp_path):
    (tmp_path / "assets").mkdir()
    path = tmp_path / "assets/outside.webp"
    Image.new("RGBA", (64, 64), "red").save(path)
    time = {"keys": [[0, 0], [720, 1]], "mode": "daily"}
    layers = [layer(asset="assets/outside.webp", x=-5000, w=100, h=100,
                    time=deepcopy(time), opacity=.7, color=[1, .5, .8], future={"value": 3})]
    original = deepcopy(layers)
    stats = compression.fit_layers(tmp_path, layers, config(), 3840, 2160)
    assert len(layers) == 1 and layers == original and stats["裁切图层"] == 1
    with Image.open(path) as image:
        assert image.size == (2, 2) and image.getchannel("A").getextrema() == (0, 0)


def test_visible_layer_keeps_unknown_fields(tmp_path, background):
    stage = stage_with_background(tmp_path, background)
    extras = {"time": {"keys": [[0, .2], [360, 1]]}, "opacity": .4, "color": [1, .5, .2], "custom": ["值", 3]}
    layers = [layer(**deepcopy(extras))]
    compression.fit_layers(stage, layers, config(画面缩放=2.), 3840, 2160)
    assert {k: layers[0][k] for k in extras} == extras


@pytest.fixture(scope="module")
def source_video(tmp_path_factory):
    path = tmp_path_factory.mktemp("画质视频") / "source.mp4"
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "testsrc=size=3840x2160:rate=12:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "96k", str(path)], check=True, capture_output=True)
    return path


def video_stage(stage, source, audio=True, duration=2):
    (stage / "assets").mkdir(parents=True)
    video = stage / "assets/wallpaper.mp4"
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(source), "-t", str(duration), "-map", "0:v:0",
                    *(["-map", "0:a?"] if audio else []), "-c", "copy", str(video)], check=True, capture_output=True)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(video), "-frames:v", "1", "-update", "1", str(stage / "assets/poster.jpg")],
                   check=True, capture_output=True)
    return layer(asset="assets/poster.jpg", video="assets/wallpaper.mp4")


def audio_bytes(path):
    return subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
                           "-i", str(path), "-map", "0:a:0", "-c:a", "copy", "-f", "adts", "pipe:1"],
                          check=True, capture_output=True).stdout


@pytest.mark.parametrize("audio", [False, True])
def test_video_resizes_with_poster_and_preserves_audio(tmp_path, source_video, audio):
    layers = [video_stage(tmp_path, source_video, audio)]
    path = tmp_path / layers[0]["video"]
    before = path.stat().st_size
    sound = audio_bytes(path) if audio else None
    c = config(画面缩放=2.)
    stats = compression.fit_layers(tmp_path, layers, c, 3840, 2160)
    info = video_info(path)
    box = geometry(3840, 2160, layers, c, 976, 596)[0]
    assert all(n % 2 == 0 for n in info["source_size"])
    assert all(abs(n - box[key]) <= 2 for n, key in zip(info["source_size"], ("w", "h")))
    assert path.stat().st_size < before and info["duration"] == pytest.approx(2, abs=.1)
    assert stats["视频"] == stats["裁切图层"] == stats["缩小图层"] == 1
    assert all(abs(a - b) <= 2 for a, b in zip(info["source_size"], dimensions(tmp_path / layers[0]["asset"])))
    assert path.read_bytes().index(b"moov") < path.read_bytes().index(b"mdat")
    with Image.open(tmp_path / layers[0]["asset"]) as image:
        assert image.format == "JPEG"
    if audio:
        assert info["audio_codec"] == "aac" and audio_bytes(path) == sound
    else:
        assert "audio_codec" not in info
    assert not list((tmp_path / "assets").glob("画质压缩-*"))


def test_multiple_videos_share_remaining_budget_by_duration(tmp_path, source_video, monkeypatch):
    first = video_stage(tmp_path / "one", source_video, duration=1)
    second = video_stage(tmp_path / "two", source_video, duration=2)
    stage = tmp_path / "one"
    for path in (tmp_path / "two/assets").iterdir():
        path.rename(stage / "assets" / ("second_" + path.name))
    second.update(asset="assets/second_poster.jpg", video="assets/second_wallpaper.mp4", rotation=10)
    (stage / "assets/其他.bin").write_bytes(b"x" * 20000)
    # 缩小总预算以验证真实码率约束，避免制造 180 MB 的测试资源。
    monkeypatch.setattr(compression, "VIDEO_BUDGET", 240 * 1024)
    allocations = []
    encode = compression._fit_video

    def record(path, info, crop, target, crf, budget):
        allocations.append((info["duration"], budget))
        return encode(path, info, crop, target, crf, budget)

    monkeypatch.setattr(compression, "_fit_video", record)
    stats = compression.fit_layers(stage, [first, second], config(), 3840, 2160)
    assert stats["视频"] == 2 and stats["处理后字节"] <= compression.VIDEO_BUDGET
    assert allocations[0][1] / allocations[1][1] == pytest.approx(allocations[0][0] / allocations[1][0])
    other = sum(p.stat().st_size for p in (stage / "assets").iterdir() if p.suffix != ".mp4")
    assert sum(budget for duration, budget in allocations) == pytest.approx(compression.VIDEO_BUDGET - other)
