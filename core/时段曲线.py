"""把局部时段变换换算成输出图片中心的场景坐标曲线。"""
from copy import deepcopy
import math

import numpy as np


def sample(points, minute):
    for (start, left), (end, right) in zip(points, points[1:]):
        if minute <= end:
            return np.asarray(left) + (np.asarray(right) - left) * ((minute - start) / (end - start))
    return np.asarray(points[-1][1])


def layer_curve(layer, definition):
    reference = definition["reference"]
    result = {"alpha": deepcopy(definition["alpha"])} if "alpha" in definition else {}
    fields = [field for field in ("origin", "scale", "angles") if field in definition]
    if not fields:
        return result
    minutes = sorted({minute for field in fields for minute, _ in definition[field]})
    pa, pb, pc, pd, px, py = reference["parent"]
    parent = np.array([[pa, pb], [pc, pd]])
    a, b, c, d, x, y = reference["matrix"]
    inverse = np.linalg.inv([[a, b], [c, d]])
    center = np.array([layer["x"], reference["height"] - layer["y"]])
    local_center = inverse @ (center - [x, y])
    angle0 = -math.radians(layer["rotation"])
    basis = np.array([[math.cos(angle0), -math.sin(angle0)], [math.sin(angle0), math.cos(angle0)]])
    for key in ("dx", "dy", "sx", "sy", "rot"):
        result[key] = []
    for minute in minutes:
        origin, scale, angles = (sample(definition[field], minute) if field in definition else np.asarray(reference[field])
                                 for field in ("origin", "scale", "angles"))
        co, si = math.cos(angles[2]), math.sin(angles[2])
        current = parent @ np.array([[co * scale[0], -si * scale[1]], [si * scale[0], co * scale[1]]])
        moved = current @ local_center + parent @ origin[:2] + [px, py]
        # 烘焙图片可能裁在 origin 的一侧，中心位移必须连同缩放、旋转一起计算。
        transformed = current @ inverse @ basis
        rotation = math.atan2(transformed[1, 0], transformed[0, 0]) - angle0
        expected = (angles[2] - reference["angles"][2]) * (1 if np.linalg.det(parent) > 0 else -1)
        rotation += round((expected - rotation) / math.tau) * math.tau
        values = (moved[0] - center[0], center[1] - moved[1],
                  np.linalg.norm(transformed[:, 0]), np.linalg.norm(transformed[:, 1]), -math.degrees(rotation))
        for key, value in zip(("dx", "dy", "sx", "sy", "rot"), values):
            result[key].append([minute, float(value)])
    return result
