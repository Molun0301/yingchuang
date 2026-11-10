"""首次编码时实际探测硬件，并共用编码质量参数。"""
import subprocess
from threading import Lock

import imageio_ffmpeg


_encoder = None
_probe_lock = Lock()


def encoder():
    global _encoder
    # 场景视频与资源压缩会由多个线程同时进入，只让首次调用执行探测。
    with _probe_lock:
        if _encoder is None:
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            for candidate in ("h264_nvenc", "h264_qsv", "h264_amf"):
                result = subprocess.run(
                    [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                     "-f", "lavfi", "-i", "testsrc=size=320x240:rate=1", "-frames:v", "1",
                     "-an", "-c:v", candidate, "-pix_fmt", "yuv420p", "-f", "null", "-"],
                    capture_output=True)
                if result.returncode == 0:
                    _encoder = candidate
                    break
            else:
                _encoder = "libx264"
    return _encoder


def encoder_args(quality=None, preset=None):
    """质量模式映射原 CRF 数值；未指定质量时由调用方提供固定码率。"""
    name = encoder()
    args = ["-c:v", name]
    if name == "libx264":
        if preset is not None:
            args += ["-preset", preset]
        if quality is not None:
            args += ["-crf", str(quality)]
    elif name == "h264_nvenc":
        # 实测同一画面下 NVENC 的 cq 比 libx264 的 crf 大 5 左右体积与画质才相当（SSIM 0.986 / 0.985），并开启高质量预设与自适应量化。
        args += ["-rc", "cbr"] if quality is None else ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", str(quality + 5), "-b:v", "0",
                                                         "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "3", "-rc-lookahead", "32"]
    elif name == "h264_qsv":
        if quality is not None:
            args += ["-global_quality", str(quality)]
    elif name == "h264_amf":
        args += ["-rc", "cbr"] if quality is None else ["-rc", "cqp", "-qp_i", str(quality), "-qp_p", str(quality), "-qp_b", str(quality)]
    return args
