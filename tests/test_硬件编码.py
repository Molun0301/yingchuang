"""验证实际探测顺序、并发共用结果和两种码率语义。"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))
import 硬件编码 as hardware


@pytest.mark.parametrize("available,expected,attempts", [
    ({"h264_nvenc", "h264_qsv"}, "h264_nvenc", ["h264_nvenc"]),
    ({"h264_qsv", "h264_amf"}, "h264_qsv", ["h264_nvenc", "h264_qsv"]),
    ({"h264_amf"}, "h264_amf", ["h264_nvenc", "h264_qsv", "h264_amf"]),
    (set(), "libx264", ["h264_nvenc", "h264_qsv", "h264_amf"]),
])
def test_parallel_first_use_probes_once(monkeypatch, available, expected, attempts):
    monkeypatch.setattr(hardware, "_encoder", None)
    called = []

    def probe(command, **kwargs):
        name = command[command.index("-c:v") + 1]
        assert command[command.index("-f") + 1] == "lavfi"
        assert command[-3:] == ["-f", "null", "-"]
        assert command[command.index("-frames:v") + 1] == "1"
        called.append(name)
        # 让其他线程在探测尚未完成时进入，覆盖真实并行转码的首次调用。
        time.sleep(.01)
        return subprocess.CompletedProcess(command, 0 if name in available else 1)

    monkeypatch.setattr(hardware.subprocess, "run", probe)
    with ThreadPoolExecutor(max_workers=4) as pool:
        selected = list(pool.map(lambda _: hardware.encoder(), range(8)))
    assert selected == [expected] * 8
    assert called == attempts


@pytest.mark.parametrize("name,quality_args", [
    ("libx264", ["-preset", "fast", "-crf", "24"]),
    ("h264_nvenc", ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "29", "-b:v", "0",
                    "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "3", "-rc-lookahead", "32"]),
    ("h264_qsv", ["-global_quality", "24"]),
    ("h264_amf", ["-rc", "cqp", "-qp_i", "24", "-qp_p", "24", "-qp_b", "24"]),
])
def test_quality_and_fixed_bitrate_keep_distinct_modes(monkeypatch, name, quality_args):
    monkeypatch.setattr(hardware, "encoder", lambda: name)
    assert hardware.encoder_args(quality=24, preset="fast") == ["-c:v", name, *quality_args]
    fixed = hardware.encoder_args(preset="fast") + ["-b:v", "800000", "-maxrate", "800000", "-bufsize", "1600000"]
    assert fixed.count("-b:v") == 1
    assert all(option not in fixed for option in ("-crf", "-cq", "-global_quality", "-qp_i", "-qp_p", "-qp_b"))
    if name in {"h264_nvenc", "h264_amf"}:
        assert fixed[fixed.index("-rc") + 1] == "cbr"
