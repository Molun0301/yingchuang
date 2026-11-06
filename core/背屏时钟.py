"""从主题的实际字体引用生成无描边的动态时钟字形。"""

from datetime import datetime
from hashlib import sha256
from io import BytesIO
import math
from pathlib import Path
import re

from fontTools.ttLib import TTFont, TTLibError
from PIL import Image, ImageDraw, ImageFont


ROLES = ("星期", "日期", "时间")
WEEK_EN = ("SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY")
WEEK_ZH = tuple("星期" + x for x in "日一二三四五六")
ROLE_NAMES = (
    {"day", "week", "weekday", "dayofweek", "星期", "周几"},
    {"date", "dat", "calendar", "日期", "年月日"},
    {"clock", "time", "hours", "时间", "时钟"},
)
RASTER_SCALE = 3
FONT_LIMIT = 32 * 1024 * 1024


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
    """优先使用每一行的源字体，无法确定时停止转换。"""
    overrides = overrides or {}
    all_fonts, role_fonts = theme_font_sources(objects, worlds, properties)
    clock_fonts = {path for fonts in role_fonts.values() for path in fonts}
    cache = {}
    selected = {}
    for role in ROLES:
        candidates = role_fonts[role]
        override = overrides.get(role, overrides.get("全部"))
        if override is not None:
            data = read_font_data(override)
            selected[role] = (data, {"字体文件": override.name, "选取规则": "用户明确指定",
                                     "主题声明": sorted(candidates),
                                     "源图层": [layer for group in candidates.values() for layer in group]})
            continue
        if len(candidates) > 1:
            raise ValueError(f"{role}对应多个源字体（{'、'.join(sorted(candidates))}），请用 --font {role}=字体文件 明确指定。")
        if candidates:
            path = next(iter(candidates))
            source_layers = candidates[path]
            reason = "该行的可见源时钟图层"
        else:
            fallback = clock_fonts or set(all_fonts)
            if len(fallback) != 1:
                raise ValueError(f"无法确定{role}的原字体。请用 --font {role}=字体文件 指定，或用 --no-clock 仅转换画面。")
            path = next(iter(fallback))
            source_layers = all_fonts[path]
            reason = "沿用唯一源时钟字体" if clock_fonts else "沿用主题可见文字的唯一字体"
        if package is None or not package.has(path):
            raise ValueError(f"主题声明的{role}字体 {path} 未随工程提供。请用 --font {role}=原字体文件 补齐。")
        if path not in cache:
            cache[path] = package.read(path)
            if len(cache[path]) > FONT_LIMIT:
                raise ValueError(f"{role}的源字体文件过大。")
        selected[role] = (cache[path], {"字体文件": path, "选取规则": reason, "源图层": source_layers})
    return selected


def checked_font(data, role, glyphs, size):
    try:
        with TTFont(BytesIO(data), fontNumber=0) as font:
            cmap = font.getBestCmap() or {}
            family = font["name"].getDebugName(4) or font["name"].getDebugName(1)
            absent = "".join(sorted({char for char in glyphs if cmap.get(ord(char), ".notdef") == ".notdef"}))
    except (TTLibError, ValueError, OSError, KeyError, IndexError) as exc:
        raise ValueError(f"无法读取{role}的字体文件。") from exc
    if absent:
        raise ValueError(f"{role}字体 {family or '未命名字体'} 缺少字形「{absent}」。请明确指定可显示这些字的字体。")
    return ImageFont.truetype(BytesIO(data), size * RASTER_SCALE, index=0), family or "未命名字体"


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
    image.save(stage / file, optimize=True)


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


def ink_color(config, source, key=None):
    chosen = config.get("时钟颜色", {}).get(key)
    if chosen:
        return chosen
    if config["文字颜色"] != "原主题":
        return config["文字颜色"]
    colors = {layer["文字颜色"] for layer in source.get("源图层", []) if "文字颜色" in layer}
    return next(iter(colors)) if len(colors) == 1 else "#F8FBFF"


def build_clock(stage, config, selected):
    words = WEEK_ZH if config["星期语言"] == "中文" else WEEK_EN
    defaults = [43, 34, 62 if config["显示秒"] else 69]
    keys = ("week", "date", "time")
    sizes = [int(round(config.get("时钟排版", {}).get(key, {}).get("size", size))) for key,size in zip(keys,defaults)]
    required = ["".join(words), "0123456789.", "0123456789:"]
    fonts, audit = [], {}
    for role, glyphs, size, key in zip(ROLES, required, sizes, keys):
        data, source = selected[role]
        font, family = checked_font(data, role, glyphs, size)
        fonts.append(font)
        audit[role] = {**source, "字体内名": family, "SHA-256": sha256(data).hexdigest(),
                       "字号": size, "输出文字颜色": ink_color(config, source, key)}
    week_font, date_font, time_font = fonts
    bounds = ink_bounds(week_font, words)
    width = max(ink_width(week_font, text) for text in words) + 2
    height = math.ceil((bounds[1]-bounds[0]) / RASTER_SCALE)
    week_files = [f"assets/clock_week_{i}.png" for i in range(7)]
    for word, file in zip(words, week_files):
        write_glyph(stage, file, word, week_font, width, height, bounds, audit["星期"]["输出文字颜色"])
    week = {"key": "week", "w": width, "h": height, "weekdays": week_files}
    date = number_row(stage, date_font, "date", ["Y3","Y2","Y1","Y0",".","M1","M0",".","D1","D0"], ".",
                      audit["日期"]["输出文字颜色"])
    fields = ["h1","h0",":","m1","m0"]
    if config["显示秒"]:
        fields += [":","s1","s0"]
    time = number_row(stage, time_font, "time", fields, ":", audit["时间"]["输出文字颜色"])
    rows = [week, date, time]
    offsets = [0]
    for i, baseline in enumerate((60, 126), start=1):
        separation = (rows[i-1]["h"] + rows[i]["h"]) / 2 + 10
        offsets.append(max(baseline, offsets[-1] + separation))
    top, bottom = -week["h"]/2, offsets[-1] + time["h"]/2
    center = (top+bottom)/2
    for row, offset in zip(rows, offsets):
        row["y"] = offset-center
        custom = config.get("时钟排版", {}).get(row["key"])
        if custom:
            row.update({"nx":custom["x"],"ny":custom["y"],"visible":custom.get("visible",True),"sourceVisible":custom.get("sourceVisible",True),"align":custom.get("align","center")})
    time["hourFormat"] = config.get("时制", "24")
    return {"rows": rows, "sizes": sizes, "week_names": list(words), "height": bottom-top,
            "half_width": max(176, max(row["w"] for row in rows)/2), "margin": 12,
            "assets": week_files + date["digits"] + time["digits"] +
                      [part["asset"] for row in (date,time) for part in row["pieces"] if "asset" in part],
            "fonts": audit}


DIGIT_VARS = {"Y": "year", "M": "month1", "D": "date", "h": "hour24", "m": "minute", "s": "second"}


def digit_expression(field):
    var = "#" + DIGIT_VARS[field[0]]
    place = 10 ** int(field[1])
    return f"int({var}/{place})%10" if place > 1 else f"{var}%10"


def draw_clock(canvas, stage, clock, center_x, center_y, unit):
    now = datetime.now().astimezone()
    digits = dict(zip(DIGIT_VARS, (now.year, now.month, now.day, now.hour, now.minute, now.second)))

    def paint(file, x, y, w, h):
        with Image.open(stage/file) as image:
            bitmap = image.convert("RGBA").resize((max(1,round(w*unit)),max(1,round(h*unit))), Image.Resampling.LANCZOS)
        canvas.alpha_composite(bitmap, (round(x-bitmap.width/2),round(y-bitmap.height/2)))

    for row in clock["rows"]:
        if row.get("visible") is False: continue
        cx = row["nx"]*canvas.width if "nx" in row else center_x
        y = row["ny"]*canvas.height if "ny" in row else center_y + row["y"]*unit
        if row.get("align") == "left": cx += row["w"]*unit/2
        elif row.get("align") == "right": cx -= row["w"]*unit/2
        if row["key"] == "week":
            paint(row["weekdays"][(now.weekday()+1)%7], cx, y, row["w"], row["h"])
            continue
        digits["h"] = (now.hour%12 or 12) if row.get("hourFormat") == "12" else now.hour
        for part in row["pieces"]:
            file = part.get("asset")
            if not file:
                field = part["digit"]
                file = row["digits"][digits[field[0]] // (10**int(field[1])) % 10]
            paint(file, cx + part["x"]*unit, y, part["w"], row["h"])
