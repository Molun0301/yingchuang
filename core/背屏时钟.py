"""从主题的实际字体引用生成无描边的动态时钟与背屏组件字形。"""

from datetime import datetime
from functools import lru_cache
from hashlib import sha256
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import sys

from fontTools.ttLib import TTFont, TTLibError
from PIL import Image, ImageDraw, ImageFont


ROLES = ("星期", "日期", "时间")
CORE_KEYS = ("week", "date", "time")
ROLE_KEYS = dict(zip(ROLES, CORE_KEYS))
WEEK_EN = ("SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY")
WEEK_ZH = tuple("星期" + x for x in "日一二三四五六")
ROLE_NAMES = (
    {"day", "week", "weekday", "dayofweek", "星期", "周几"},
    {"date", "dat", "calendar", "日期", "年月日"},
    {"clock", "time", "hours", "时间", "时钟"},
)
RASTER_SCALE = 3
FONT_LIMIT = 32 * 1024 * 1024
WIDGET_DATA = json.loads((Path(__file__).resolve().parent / "组件.json").read_text(encoding="utf-8"))
FIELDS = WIDGET_DATA["fields"]
WIDGETS = {item["key"]: item for item in WIDGET_DATA["widgets"]}
TOKEN = re.compile(r"\{(\w+)(?:\.(\d))?(?::(\d))?\}")
# 备用字体按顺序挑选；名称比较时去掉大小写、空格和连字符。
FALLBACK_NAMES = ("misans", "msyh", "microsoftyahei", "notosanscjksc", "notosanscjk", "notosanssc", "sourcehansans",
                  "思源黑体", "wqyzenhei", "wqymicrohei", "wenquanyi", "pingfang", "simhei", "deng", "dejavusans",
                  "notosans", "arial", "segoeui", "liberationsans")
HEAVY = re.compile(r"bold|black|heavy|italic|oblique|thin|extralight|ultralight|condensed|mono|semilight|light", re.I)


def normalized(text):
    return "".join(char for char in text.casefold() if char.isalnum())


def clock_roles(obj, text):
    label = normalized(str(obj.get("name", "")))
    sample = normalized(text)
    roles = {role for role, names in zip(ROLES, ROLE_NAMES) if label in names or sample in names}
    if sample in {normalized(day) for day in WEEK_EN + WEEK_ZH}:
        roles.add("星期")
    if re.search(r"(?<!\d)\d{4}[-./年]\d{1,2}[-./月]\d{1,2}(?!\d)", text):
        roles.add("日期")
    if re.search(r"(?<!\d)\d{1,2}:\d{2}(?!\d)", text):
        roles.add("时间")
    return roles


def parse_font_options(values):
    options = {}
    for option in values:
        role, equals, name = option.partition("=")
        if not equals or role not in ROLES:
            role, name = "全部", option
        if not name or role in options:
            raise ValueError("每个时钟位置只能明确指定一个字体文件。")
        options[role] = Path(name).expanduser()
    return options


def theme_value(value, properties):
    if not isinstance(value, dict):
        return value
    user = value.get("user")
    setting = properties.get(user, {}) if isinstance(user, str) else {}
    return setting.get("value", value.get("value"))


def theme_color(obj, properties):
    color = theme_value(obj.get("color"), properties)
    values = color.split() if isinstance(color, str) else color
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        return None
    try:
        rgb = [float(component) for component in values]
    except (ValueError, TypeError):
        return None
    if all(math.isfinite(component) and 0 <= component <= 1 for component in rgb):
        return "#" + "".join(f"{round(component*255):02X}" for component in rgb)
    return None


def theme_font_sources(objects, worlds, properties):
    all_fonts = {}
    role_fonts = {role: {} for role in ROLES}
    for obj in objects:
        state = worlds.get(obj["id"])
        if state is None or state.get("alpha", 1) <= 0:
            continue
        text = obj.get("text")
        if isinstance(text, dict):
            text = text.get("value")
        font = theme_value(obj.get("font"), properties)
        if not isinstance(text, str) or not isinstance(font, str) or not font.strip():
            continue
        font = font.replace("\\", "/").strip()
        entry = {"编号": obj["id"], "名称": str(obj.get("name", ""))}
        color = theme_color(obj, properties)
        if color:
            entry["文字颜色"] = color
        all_fonts.setdefault(font, []).append(entry)
        for role in clock_roles(obj, text[:512]):
            role_fonts[role].setdefault(font, []).append(entry)
    return all_fonts, role_fonts


def read_font_data(path):
    if not path.is_file() or path.stat().st_size > FONT_LIMIT:
        raise ValueError(f"字体文件缺失或过大：{path}")
    return path.read_bytes()


def select_fonts(package, objects, worlds, properties, overrides=None):
    """
    按每一行的源字体选择字体。无法确定、文件缺失时该行字体为 None 并附提醒，
    由 build_clock 改用备用字体，转换不因字体中断。
    """
    overrides = overrides or {}
    all_fonts, role_fonts = theme_font_sources(objects, worlds, properties)
    clock_fonts = {path for fonts in role_fonts.values() for path in fonts}
    cache = {}
    selected = {}
    for role in ROLES:
        candidates = role_fonts[role]
        override = overrides.get(role, overrides.get("全部"))
        if override is not None:
            record = {"字体文件": override.name, "选取规则": "用户明确指定", "主题声明": sorted(candidates),
                      "源图层": [layer for group in candidates.values() for layer in group]}
            try:
                selected[role] = (read_font_data(override), record)
            except (ValueError, OSError) as exc:
                selected[role] = (None, {**record, "提醒": str(exc)})
            continue
        notice = None
        if len(candidates) > 1:
            # 多个候选时取图层最多的一个，字体名排序保证结果稳定。
            path = sorted(candidates, key=lambda name: (-len(candidates[name]), name))[0]
            source_layers = candidates[path]
            reason = "该行图层最多的源字体"
            notice = f"原主题的{role}用了多个字体，已使用 {Path(path).stem}"
        elif candidates:
            path = next(iter(candidates))
            source_layers = candidates[path]
            reason = "该行的可见源时钟图层"
        else:
            fallback = clock_fonts or set(all_fonts)
            if len(fallback) != 1:
                selected[role] = (None, {"字体文件": "", "选取规则": "未找到原字体", "源图层": [],
                                         "提醒": f"无法确定{role}的原字体"})
                continue
            path = next(iter(fallback))
            source_layers = all_fonts[path]
            reason = "沿用唯一源时钟字体" if clock_fonts else "沿用主题可见文字的唯一字体"
        record = {"字体文件": path, "选取规则": reason, "源图层": source_layers}
        if notice:
            record["提醒"] = notice
        if package is None or not package.has(path):
            selected[role] = (None, {**record, "提醒": f"主题声明的{role}字体 {Path(path).name} 未随主题提供"})
            continue
        if path not in cache:
            try:cache[path] = package.read(path)
            except (ValueError, OSError) as exc:
                selected[role] = (None, {**record, "提醒": f"无法读取{role}的源字体：{exc}"})
                continue
        if len(cache[path]) > FONT_LIMIT:
            selected[role] = (None, {**record, "提醒": f"{role}的源字体文件过大"})
            continue
        selected[role] = (cache[path], record)
    return selected


def font_index(font_file, prefer=("SC", "CN", "Hans")):
    """字体集合文件中优先取简体中文的那一款。"""
    from fontTools.ttLib import TTCollection
    with TTCollection(font_file, lazy=True) as collection:
        names = [font["name"].getDebugName(4) for font in collection.fonts]
    for tag in prefer:
        for index, name in enumerate(names):
            if re.search(rf"\b{tag}\b", name):
                return index
    return 0


def font_coverage(data, index=0):
    """返回字体内名与字符表；无法读取时返回 None。"""
    try:
        with TTFont(BytesIO(data), fontNumber=index, lazy=True) as font:
            cmap = font.getBestCmap() or {}
            family = font["name"].getDebugName(4) or font["name"].getDebugName(1) or "未命名字体"
            return family, cmap
    except (TTLibError, ValueError, OSError, KeyError, IndexError):
        return None


def missing_glyphs(cmap, glyphs):
    return "".join(sorted({char for char in glyphs if not char.isspace() and cmap.get(ord(char), ".notdef") == ".notdef"}))


def system_font_dirs():
    if sys.platform == "win32":
        return [Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts", Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Windows/Fonts"]
    return [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts", Path.home() / ".local/share/fonts"]


@lru_cache(maxsize=1)
def fallback_candidates():
    found = []
    for root in system_font_dirs():
        for folder, _, files in os.walk(root):
            for name in files:
                path = Path(folder) / name
                if path.suffix.lower() not in {".ttf", ".otf", ".ttc"}:
                    continue
                stem = normalized(path.stem)
                rank = next((i for i, key in enumerate(FALLBACK_NAMES) if stem.startswith(key) or key in stem), None)
                if rank is not None:
                    weight = 0 if re.search(r"regular|normal|book", path.stem, re.I) else 2 if HEAVY.search(path.stem) else 1
                    found.append((rank, weight, len(path.stem), str(path)))
    return [Path(item[-1]) for item in sorted(found)]


@lru_cache(maxsize=32)
def fallback_font(glyphs):
    """找一款能显示全部字符的本机字体，返回 (字体数据, 集合序号, 字体内名)；找不到时返回 None。"""
    for path in fallback_candidates():
        data = path.read_bytes()
        index = font_index(path) if path.suffix.lower() == ".ttc" else 0
        coverage = font_coverage(data, index)
        if coverage and not missing_glyphs(coverage[1], glyphs):
            return data, index, coverage[0]
    return None


def resolve_font(data, glyphs, size, label, source):
    """
    检查字体能否显示 glyphs，不能时换用备用字体。
    返回 (字体对象, 字体内名, 实际数据, 提醒)；连备用字体都没有时字体对象为 None。
    """
    notice = source.get("提醒")
    coverage = font_coverage(data, source.get("集合序号", 0)) if data else None
    if coverage is not None:
        absent = missing_glyphs(coverage[1], glyphs)
        if not absent:
            index = source.get("集合序号", 0)
            return ImageFont.truetype(BytesIO(data), size * RASTER_SCALE, index=index), coverage[0], data, notice
        shown = absent if len(absent) <= 8 else absent[:8] + "…"
        notice = f"{label}字体 {coverage[0]} 缺少「{shown}」"
    elif data:
        notice = f"无法读取{label}的字体文件"
    notice = notice or f"{label}没有可用字体"
    backup = fallback_font(glyphs)
    if backup is None:
        return None, "", None, notice + "，本机也没有能显示的备用字体，已隐藏"
    backup_data, index, family = backup
    return (ImageFont.truetype(BytesIO(backup_data), size * RASTER_SCALE, index=index), family, backup_data,
            notice + f"，已临时改用 {family}")


def ink_bounds(font, texts):
    boxes = [font.getbbox(text, anchor="ls") for text in texts]
    return min(box[1] for box in boxes), max(box[3] for box in boxes)


def ink_width(font, text):
    left, _, right, _ = font.getbbox(text, anchor="ls")
    return max(1, math.ceil((right-left) / RASTER_SCALE))


def write_glyph(stage, file, text, font, width, height, bounds, color):
    image = Image.new("RGBA", (width * RASTER_SCALE, height * RASTER_SCALE))
    left, _, right, _ = font.getbbox(text, anchor="ls")
    top, bottom = bounds
    x = (image.width - right + left) / 2 - left
    baseline = (image.height - bottom + top) / 2 - top
    ImageDraw.Draw(image).text((x, baseline), text, anchor="ls", font=font, fill=color)
    image.save(stage / file, compress_level=1)


def write_text(stage, file, text, font, height, bounds, color):
    """按字符前进宽度生成文字图片，保留前后空格形成的间距；返回输出宽度。"""
    left, _, right, _ = font.getbbox(text, anchor="ls")
    start, end = min(0, left), max(font.getlength(text), right)
    width = max(1, math.ceil((end - start) / RASTER_SCALE) + 2)
    image = Image.new("RGBA", (width * RASTER_SCALE, height * RASTER_SCALE))
    top, bottom = bounds
    baseline = (image.height - bottom + top) / 2 - top
    ImageDraw.Draw(image).text((RASTER_SCALE - start, baseline), text, anchor="ls", font=font, fill=color)
    image.save(stage / file, compress_level=1)
    return width


def number_row(stage, font, key, fields, punctuation, color):
    digits = "0123456789"
    bounds = ink_bounds(font, digits)
    height = math.ceil((bounds[1]-bounds[0]) / RASTER_SCALE)
    width = max(ink_width(font, digit) for digit in digits) + 2
    number_files = [f"assets/clock_{key}_num_{i}.png" for i in range(10)]
    for digit, file in zip(digits, number_files):
        write_glyph(stage, file, digit, font, width, height, bounds, color)
    mark_width = max(3, ink_width(font, punctuation) + 3)
    mark_file = f"assets/clock_{key}_mark.png"
    write_glyph(stage, mark_file, punctuation, font, mark_width, height, bounds, color)
    total = sum(mark_width if field == punctuation else width for field in fields)
    pieces = []
    edge = -total / 2
    for field in fields:
        part_width = mark_width if field == punctuation else width
        part = {"x": edge + part_width/2, "w": part_width}
        if field == punctuation:
            part["asset"] = mark_file
        else:
            part["digit"] = field
        pieces.append(part)
        edge += part_width
    return {"key": key, "w": total, "h": height, "digits": number_files, "pieces": pieces}


def widget_tokens(key, row):
    """把组件的显示格式拆成片段：固定文字 s、数字 n（字段、小数位、补零位数）、选项文字 c。"""
    if key == "text":
        text = (row.get("text") or WIDGETS["text"]["sample"]).strip()[:40]
        return [("s", text)] if text else []
    spec = WIDGETS[key]
    text = spec["format"] if row.get("label", True) else spec["bare"]
    tokens, position = [], 0
    for match in TOKEN.finditer(text):
        if match.start() > position:
            tokens.append(("s", text[position:match.start()]))
        field = match[1]
        tokens.append(("c", field) if "choices" in FIELDS[field] else ("n", field, int(match[2] or 0), int(match[3] or 1)))
        position = match.end()
    if position < len(text):
        tokens.append(("s", text[position:]))
    return tokens


def token_glyphs(tokens):
    text = "".join(token[1] for token in tokens if token[0] == "s")
    text += "".join(choice for token in tokens if token[0] == "c" for choice in FIELDS[token[1]]["choices"])
    numbers = [token for token in tokens if token[0] == "n"]
    if numbers:
        text += "0123456789"
    if any(token[2] for token in numbers):
        text += "."
    if any(FIELDS[token[1]].get("neg") for token in numbers):
        text += "-"
    return "".join(dict.fromkeys(text))


def seq_row(stage, font, key, tokens, color):
    """组件行：固定文字、可变位数数字与选项文字依次排列，背屏端按实际数值计算位置。"""
    numbers = [token for token in tokens if token[0] == "n"]
    probe = [token[1] for token in tokens if token[0] == "s" and token[1].strip()]
    probe += [choice for token in tokens if token[0] == "c" for choice in FIELDS[token[1]]["choices"]]
    if numbers:
        probe.append("0123456789")
    if any(token[2] for token in numbers):probe.append(".")
    if any(FIELDS[token[1]].get("neg") for token in numbers):probe.append("-")
    bounds = ink_bounds(font, probe)
    height = max(1, math.ceil((bounds[1]-bounds[0]) / RASTER_SCALE))
    row = {"key": key, "kind": "seq", "h": height, "segments": []}
    assets = []
    if numbers:
        width = max(ink_width(font, digit) for digit in "0123456789") + 2
        row["digits"] = [f"assets/w_{key}_num_{i}.png" for i in range(10)]
        row["digitW"] = width
        for digit, file in zip("0123456789", row["digits"]):
            write_glyph(stage, file, digit, font, width, height, bounds, color)
        assets += row["digits"]
        for mark, name, wanted in ((".", "dot", any(token[2] for token in numbers)),
                                   ("-", "minus", any(FIELDS[token[1]].get("neg") for token in numbers))):
            if wanted:
                file = f"assets/w_{key}_{name}.png"
                mark_width = max(3, ink_width(font, mark) + 3)
                write_glyph(stage, file, mark, font, mark_width, height, bounds, color)
                row[name] = {"asset": file, "w": mark_width}
                assets.append(file)
    for index, token in enumerate(tokens):
        if token[0] == "s":
            file = f"assets/w_{key}_s{index}.png"
            row["segments"].append({"t": "s", "asset": file, "w": write_text(stage, file, token[1], font, height, bounds, color)})
            assets.append(file)
        elif token[0] == "c":
            files = [f"assets/w_{key}_c{index}_{i}.png" for i in range(len(FIELDS[token[1]]["choices"]))]
            widths = [write_text(stage, file, text, font, height, bounds, color)
                      for file, text in zip(files, FIELDS[token[1]]["choices"])]
            row["segments"].append({"t": "c", "f": token[1], "src": f"assets/w_{key}_c{index}.png", "assets": files, "ws": widths})
            assets += files
        else:
            info = FIELDS[token[1]]
            row["segments"].append({"t": "n", "f": token[1], "dec": token[2], "pad": token[3],
                                    "neg": bool(info.get("neg")), "max": max(info.get("max", 3), token[3])})
    row["w"] = row_parts(row, field_values(datetime.now(), {}))[0]
    return row, assets


def ink_color(config, source, key=None):
    chosen = config.get("时钟颜色", {}).get(key)
    if chosen:
        return chosen
    if config["文字颜色"] != "原主题":
        return config["文字颜色"]
    colors = {layer["文字颜色"] for layer in source.get("源图层", []) if "文字颜色" in layer}
    return next(iter(colors)) if len(colors) == 1 else "#F8FBFF"


def entry_for(selected, key):
    """selected 可按角色名（星期/日期/时间）或行键给出；组件未单独指定时跟随时间行。"""
    if key in selected:
        return selected[key]
    if key in CORE_KEYS:
        return selected[next(name for name, value in ROLE_KEYS.items() if value == key)]
    data, record = entry_for(selected, "time")
    return data, {**record, "选取规则": "跟随时间字体"}


def build_clock(stage, config, selected):
    words = WEEK_ZH if config["星期语言"] == "中文" else WEEK_EN
    layout = config.get("时钟排版", {})
    defaults = {"week": 43, "date": 34, "time": 62 if config["显示秒"] else 69}
    glyphs = {"week": "".join(words), "date": "0123456789.", "time": "0123456789:"}
    rows, assets, audit, warnings = [], [], {}, []
    time_color = None
    time_data, time_index = None, 0
    keys = list(CORE_KEYS) + [key for key in WIDGETS if key not in CORE_KEYS and layout.get(key, {}).get("visible")]
    for key in keys:
        spec = WIDGETS[key]
        custom = layout.get(key, {})
        size = int(round(custom.get("size", defaults.get(key, spec["size"]))))
        tokens = None if key in CORE_KEYS else widget_tokens(key, custom)
        if tokens is not None and not tokens:
            continue
        needed = glyphs[key] if tokens is None else token_glyphs(tokens)
        data, source = entry_for(selected, key)
        if source.get("选取规则") == "跟随时间字体":
            # 跟随时间行实际采用的字体，只为组件自身缺字生成提醒。
            data = time_data
            source = {name: value for name, value in source.items() if name != "提醒"}
            source["集合序号"] = time_index
        label = spec["name"]
        font, family, used, notice = resolve_font(data, needed, size, label, source)
        color = ink_color(config, source, key) if key in CORE_KEYS or config.get("时钟颜色", {}).get(key) else time_color or ink_color(config, source, key)
        if key == "time":
            time_color = color
        if notice:
            warnings.append({"key": key, "message": notice})
        if font is None:
            continue
        if key == "time":
            time_data, time_index = used, font.index
        name = next((role for role, value in ROLE_KEYS.items() if value == key), label)
        audit[name] = {**source, "字体内名": family, "SHA-256": sha256(used).hexdigest(), "字号": size, "输出文字颜色": color,
                       **({"提醒": notice} if notice else {})}
        if key == "week":
            bounds = ink_bounds(font, words)
            width = max(ink_width(font, text) for text in words) + 2
            height = math.ceil((bounds[1]-bounds[0]) / RASTER_SCALE)
            files = [f"assets/clock_week_{i}.png" for i in range(7)]
            for word, file in zip(words, files):
                write_glyph(stage, file, word, font, width, height, bounds, color)
            row = {"key": "week", "w": width, "h": height, "weekdays": files}
            assets += files
        elif key == "date":
            row = number_row(stage, font, "date", ["Y3","Y2","Y1","Y0",".","M1","M0",".","D1","D0"], ".", color)
        elif key == "time":
            fields = ["h1","h0",":","m1","m0"] + ([":","s1","s0"] if config["显示秒"] else [])
            row = number_row(stage, font, "time", fields, ":", color)
            row["hourFormat"] = config.get("时制", "24")
        else:
            row, files = seq_row(stage, font, key, tokens, color)
            assets += files
        if key in ("date", "time"):
            assets += row["digits"] + [part["asset"] for part in row["pieces"] if "asset" in part]
        row["size"] = size
        rows.append(row)
    # 三行时钟的默认竖向排布，仅在没有逐行排版时使用。
    core = [row for row in rows if row["key"] in CORE_KEYS]
    offsets = [0]
    for i in range(1, len(core)):
        separation = (core[i-1]["h"] + core[i]["h"]) / 2 + 10
        offsets.append(max((60, 126)[i - 1], offsets[-1] + separation))
    top = -core[0]["h"]/2 if core else 0
    bottom = offsets[-1] + core[-1]["h"]/2 if core else 0
    center = (top+bottom)/2
    for row, offset in zip(core, offsets):
        row["y"] = offset-center
    for row in rows:
        row.setdefault("y", 0)
        custom = layout.get(row["key"])
        if custom:
            row.update({"nx":custom["x"],"ny":custom["y"],"visible":custom.get("visible",True),"sourceVisible":custom.get("sourceVisible",True),"align":custom.get("align","center")})
    return {"rows": rows, "sizes": [next((r["size"] for r in rows if r["key"] == k), defaults[k]) for k in CORE_KEYS],
            "week_names": list(words), "height": bottom-top,
            "half_width": max(176, max((row["w"] for row in core), default=0)/2), "margin": 12,
            "assets": assets, "fonts": audit, "warnings": warnings}


DIGIT_VARS = {"Y": "year", "M": "month1", "D": "date", "h": "hour24", "m": "minute", "s": "second"}


def digit_expression(field):
    var = "#" + DIGIT_VARS[field[0]]
    place = 10 ** int(field[1])
    return f"int({var}/{place})%10" if place > 1 else f"{var}%10"


def field_values(now, samples):
    """预览用的字段值：时钟字段取当前时刻，数据字段取示例值，农历等由调用方在 samples 中给出。"""
    values = {"Y": now.year, "M": now.month, "D": now.day, "h": now.hour, "m": now.minute, "s": now.second,
              "w": (now.weekday() + 1) % 7, "lm": 0, "ld": 0}
    values.update({name: info["sample"] for name, info in FIELDS.items() if "sample" in info})
    values.update(samples or {})
    return values


def row_parts(row, values):
    """与 core/组件绘制.cjs 的 rowParts 相同：返回总宽及各片段 (文件, 相对整行中心的 x, 宽)。"""
    if "weekdays" in row:
        return row["w"], [(row["weekdays"][values["w"]], 0, row["w"])]
    if "segments" not in row:
        fields = {**values, "h": (values["h"] % 12 or 12) if row.get("hourFormat") == "12" else values["h"]}
        return row["w"], [(part.get("asset") or row["digits"][fields[part["digit"][0]] // 10**int(part["digit"][1]) % 10],
                           part["x"], part["w"]) for part in row["pieces"]]
    parts, x = [], 0

    def put(file, width):
        nonlocal x
        parts.append([file, x + width / 2, width])
        x += width

    for seg in row["segments"]:
        if seg["t"] == "s":
            put(seg["asset"], seg["w"])
        elif seg["t"] == "c":
            index = max(0, min(len(seg["assets"]) - 1, math.floor(values[seg["f"]])))
            put(seg["assets"][index], seg["ws"][index])
        else:
            raw = values[seg["f"]]
            scale = 10 ** seg["dec"]
            units = math.floor(abs(raw) * scale + .5)
            whole = units // scale
            if seg["neg"] and raw < 0:
                put(row["minus"]["asset"], row["minus"]["w"])
            for char in str(whole).rjust(seg["pad"], "0"):
                put(row["digits"][int(char)], row["digitW"])
            if seg["dec"]:
                put(row["dot"]["asset"], row["dot"]["w"])
                for char in str(units % scale).rjust(seg["dec"], "0"):
                    put(row["digits"][int(char)], row["digitW"])
    return x, [(file, center - x / 2, width) for file, center, width in parts]


def draw_clock(canvas, stage, clock, center_x, center_y, unit, samples=None):
    values = field_values(datetime.now().astimezone(), samples)

    def paint(file, x, y, w, h):
        with Image.open(stage/file) as image:
            bitmap = image.convert("RGBA").resize((max(1,round(w*unit)),max(1,round(h*unit))), Image.Resampling.LANCZOS)
        canvas.alpha_composite(bitmap, (round(x-bitmap.width/2),round(y-bitmap.height/2)))

    for row in clock["rows"]:
        if row.get("visible") is False: continue
        width, parts = row_parts(row, values)
        cx = row["nx"]*canvas.width if "nx" in row else center_x
        y = row["ny"]*canvas.height if "ny" in row else center_y + row["y"]*unit
        if row.get("align") == "left": cx += width*unit/2
        elif row.get("align") == "right": cx -= width*unit/2
        for file, x, w in parts:
            paint(file, cx + x*unit, y, w, row["h"])
