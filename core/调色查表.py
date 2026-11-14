"""按渲染器测得的三维查色表处理直通颜色，并输出视频滤镜。"""
from pathlib import Path

import numpy as np
from PIL import Image


def apply_luts(image, luts):
    if not luts:
        return image
    pixels = np.array(image.convert("RGBA"))
    colors = pixels[..., :3].astype(np.float64)
    for lut in luts:
        size = lut["size"]
        table = np.asarray(lut["table"], dtype=np.float64).reshape(size, size, size, 3)
        grid = colors * ((size - 1) / 255)
        low = np.floor(grid).astype(int)
        high = np.minimum(low + 1, size - 1)
        fraction = grid - low
        mapped = np.zeros_like(colors)
        # 表按蓝、绿、红排列；直接在未预乘的 RGB 上插值，不改变透明度。
        for b in range(2):
            for g in range(2):
                for r in range(2):
                    bits = np.array([r, g, b])
                    indices = np.where(bits, high, low)
                    weight = np.prod(np.where(bits, fraction, 1 - fraction), axis=-1)
                    mapped += table[indices[..., 2], indices[..., 1], indices[..., 0]] * weight[..., None]
        colors = mapped
    active = pixels[..., 3] != 0
    pixels[..., :3][active] = np.rint(colors[active]).astype(np.uint8)
    return Image.fromarray(pixels)


def lut3d_filters(luts, directory):
    filters = []
    for index, lut in enumerate(luts):
        path = Path(directory) / f"调色_{index}.cube"
        rows = np.asarray(lut["table"]).reshape(-1, 3) / 255
        path.write_text(f"LUT_3D_SIZE {lut['size']}\n" +
                        "\n".join(" ".join(f"{channel:.12f}" for channel in row) for row in rows) + "\n",
                        encoding="utf-8")
        name = path.resolve().as_posix().replace(":", "\\:").replace("'", "'\\''")
        filters.append(f"lut3d=file='{name}':interp=trilinear")
    return filters
