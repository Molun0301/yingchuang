"""桌面应用的主题读取、图层缓存、排版和转换入口。"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image
from fontTools.ttLib import TTFont
import 背屏转换 as converter
import 背屏时钟 as clockwork
from 场景动效 import SceneAssets, build_motion_scene, effects_for, sprite_settings

if os.environ.get("YINGCHUANG_CORE"):
    converter.ROOT = Path(os.environ["YINGCHUANG_CORE"])

CACHE_VERSION = 11
ROLE_KEYS = dict(zip(clockwork.ROLES, ("week", "date", "time")))


def event(phase, progress):
    print(json.dumps({"event": "progress", "phase": phase, "progress": progress}, ensure_ascii=False), flush=True)


def digest(value):
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:28]


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_suffix(path.suffix + ".writing")
    staging.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(staging, path)


def commit_cache(stage, destination, marker):
    try:os.rename(stage,destination)
    except OSError:
        if not (destination/marker).is_file():raise


def binding(value, properties):
    if isinstance(value, list):
        return [binding(item, properties) for item in value]
    if not isinstance(value, dict):
        return value
    user = value.get("user")
    if isinstance(user, str) and user in properties:
        return properties[user].get("value", value.get("value"))
    if isinstance(user, dict) and user.get("name") in properties:
        current = properties[user["name"]].get("value")
        return str(current) == str(user.get("condition"))
    return {key: binding(item, properties) for key, item in value.items()}


class EditablePackage:
    """原资源始终只读，编辑值只作用于工作进程中的资源视图。"""
    def __init__(self, original, properties, engine_roots):
        self.original = original
        self.path = original.path
        self.version = getattr(original, "version", "解包场景")
        self.properties = deepcopy(properties)
        self.engine_roots = [Path(p) for p in engine_roots]
        self.files = {}
        for key, prop in self.properties.items():
            if str(prop.get("type", "")).lower() not in {"file", "scenetexture"}:
                continue
            value = prop.get("value")
            if isinstance(value, str) and value and Path(value).is_file():
                name = "user/" + digest(value) + Path(value).suffix.lower()
                self.files[name] = Path(value)
                self.files["materials/" + name] = Path(value)
                prop["value"] = name

    def has(self, name):
        return name in self.files or self.original.has(name) or self.builtin(name) is not None

    def builtin(self, name):
        relative=converter.safe_name(name)
        for root in self.engine_roots:
            candidate=(root/relative).resolve()
            if candidate.is_relative_to(root.resolve()) and candidate.is_file():return candidate
        return None

    def read(self, name):
        if name in self.files:
            return self.files[name].read_bytes()
        if self.original.has(name):data = self.original.read(name)
        else:
            builtin=self.builtin(name)
            if builtin is None:raise converter.ConversionError("原主题与壁纸引擎均缺少资源："+name)
            data=builtin.read_bytes()
        if name.lower().endswith(".json"):
            try:
                return json.dumps(binding(json.loads(data), self.properties), ensure_ascii=False).encode()
            except (UnicodeError, json.JSONDecodeError):
                pass
        return data

    def json(self, name):
        return json.loads(self.read(name))


def loaded_scene(theme, draft):
    pkg, project, scene, width, height, properties = converter.read_scene(Path(theme["source"]))
    properties = deepcopy(properties)
    for key, value in draft.get("properties", {}).items():
        if key in properties:
            properties[key]["value"] = value
    view = EditablePackage(pkg, properties, theme.get("engineRoots", []))
    scene = binding(scene, view.properties)
    if isinstance(theme.get("resolvedScene"),dict):scene=deepcopy(theme["resolvedScene"])
    for obj in scene["objects"]:
        overrides = draft.get("layers", {}).get(str(obj["id"]), {})
        for field in ("visible", "text", "alpha", "color", "fontsize"):
            if field in overrides:
                obj[field] = overrides[field]
        if overrides.get("font"):
            selected_font=overrides["font"]
            if selected_font.startswith("theme:"):obj["font"]=selected_font[6:]
            else:
                alias="user/"+digest(selected_font)+Path(selected_font).suffix
                view.files[alias]=Path(selected_font);obj["font"]=alias
        if "x" in overrides or "y" in overrides:
            origin = converter.vector(converter.value(obj.get("origin")), [width/2, height/2, 0])
            if "x" in overrides: origin[0] = float(overrides["x"]) * width
            if "y" in overrides: origin[1] = (1-float(overrides["y"])) * height
            obj["origin"] = " ".join(str(v) for v in origin)
        if "rotation" in overrides:
            obj["angles"] = "0 0 " + str(-float(overrides["rotation"]) * 3.141592653589793 / 180)
        if "scale" in overrides:
            scales = converter.vector(converter.value(obj.get("scale")), [1,1,1])
            obj["scale"] = " ".join(str(v*float(overrides["scale"])) for v in scales)
    return view, project, scene, width, height, view.properties


def font_name(data, fallback):
    try:
        with TTFont(BytesIO(data), fontNumber=0, lazy=True) as font:
            return font["name"].getDebugName(4) or font["name"].getDebugName(1) or fallback
    except Exception:
        return fallback


def raw_clock_ids(theme):
    """完整画面模式也要隐藏原主题的时钟文字层；透视场景不经正交检查直接读取图层。"""
    source = Path(theme["source"])
    pkg = converter.Package(source) if source.suffix.lower() == ".pkg" else converter.SceneFolder(source)
    name = source.name if isinstance(pkg, converter.SceneFolder) else "scene.json"
    objects = pkg.json(name).get("objects", [])
    return [obj["id"] for obj in objects if isinstance(obj, dict) and "text" in obj
            and isinstance(converter.value(obj["text"], ""), str) and clockwork.clock_roles(obj, converter.value(obj["text"], ""))]


def inspect_theme(request):
    theme = request["theme"]
    if theme["type"] != "scene":
        return {"hasClock": False, "fonts": [], "layers": [], "sourceSize": None, "clockLayerIds": [],
                "renderable": theme["type"] in {"image", "video"}, "fontIssue": "",
                **({} if theme["type"] in {"image", "video"} else {"reason": "原生图层只支持场景、图片和视频，请使用完整画面导出。"})}
    try:
        pkg, project, scene, width, height, props = loaded_scene(theme, request.get("draft", {}))
    except ValueError as exc:
        try: clock_ids = raw_clock_ids(theme)
        except (ValueError, OSError, KeyError): clock_ids = []
        return {"hasClock": False, "fonts": [], "layers": [], "sourceSize": None, "renderable": False, "fontIssue": "",
                "reason": str(exc), "clockLayerIds": clock_ids}
    worlds = converter.world_transforms(scene["objects"], props, width, height, [])
    candidates, role_fonts = clockwork.theme_font_sources(scene["objects"], worlds, props)
    font_paths=set(candidates)
    for obj in scene["objects"]:
        name=clockwork.theme_value(obj.get("font"),props)
        if isinstance(name,str) and name.strip():font_paths.add(name)
    fonts = []
    for name in sorted(font_paths):
        try:
            if pkg.has(name):fonts.append({"value": "theme:" + name, "label": font_name(pkg.read(name), Path(name).stem)})
        except ValueError:pass
    font_issue = ""
    try:
        selected = clockwork.select_fonts(pkg, scene["objects"], worlds, props)
        has_clock = any(role_fonts.values())
        source_fonts = {ROLE_KEYS[role]: record["字体文件"] for role, (_, record) in selected.items()}
        source_colors = {ROLE_KEYS[role]: clockwork.ink_color({"文字颜色": "原主题"}, record) for role, (_, record) in selected.items()}
    except ValueError as exc:
        has_clock, source_fonts, source_colors = False, {}, {}
        if any(role_fonts.values()): font_issue = str(exc)
    layers = []
    for obj in scene["objects"]:
        if not any(k in obj for k in ("image", "text", "particle")): continue
        origin = converter.vector(converter.value(obj.get("origin")), [width/2, height/2, 0])
        raw_text = converter.value(obj.get("text"), "")
        color = clockwork.theme_color(obj, props)
        layers.append({"id": str(obj["id"]), "name": str(obj.get("name", obj["id"])),
                       "kind": "text" if "text" in obj else "particle" if "particle" in obj else "image",
                       "visible": worlds.get(obj["id"]) is not None,
                       "x": origin[0]/width, "y": 1-origin[1]/height,
                       "text": raw_text if isinstance(raw_text, str) else "", "color": color or "#ffffff",
                       "font":clockwork.theme_value(obj.get("font"),props),
                       "alpha": float(converter.value(obj.get("alpha"), 1)),
                       "fontsize": float(converter.value(obj.get("fontsize"), 32))})
    _,_,original,_,_,original_props=converter.read_scene(Path(theme["source"]))
    clock_ids=[obj["id"] for obj in original["objects"] if "text" in obj and isinstance(converter.value(obj["text"],""),str)
               and clockwork.clock_roles(obj,converter.value(obj["text"],""))]
    return {"hasClock": has_clock, "fonts": fonts, "sourceFonts": source_fonts, "sourceColors": source_colors,
            "fontIssue": font_issue, "layers": layers, "sourceSize": [width,height], "renderable": True, "clockLayerIds": clock_ids,
            "scriptInput":{"scene":original,"properties":original_props,"width":width,"height":height,"clockLayerIds":clock_ids}}


def layer_plan(request):
    """
    逐层渲染的规划：所有可见图层逐个单独渲染，保留逐层感应。
    合成、投影、全屏层取下方已绘制的画面再处理：下方只有一个感应幅度相同的图层时（如只处理背景的模糊层），
    两者渲染成一层（members），画面与电脑一致且不减少图层；下方有多个图层时不合并，隐藏并记录。
    varying 为随时段变化的对象，不参与合成。
    """
    theme = request["theme"]
    pkg,_,scene,sw,sh,props = loaded_scene(theme,request.get("draft",{}))
    worlds = converter.world_transforms(scene["objects"],props,sw,sh,[])
    assets = SceneAssets(pkg,None,converter.decode_tex)
    clock_ids = set(raw_clock_ids(theme))
    varying = set(request.get("varying",[]))
    targets,hidden,unsupported = [],[],[]
    # 下方有背屏另行播放的视频时，渲染器取不到它的画面，不能合成。
    captured = True
    for obj in scene["objects"]:
        state = worlds.get(obj["id"])
        if state is None or state["alpha"]<=0:continue
        name = str(obj.get("name",obj["id"]))
        image = obj.get("image")
        if isinstance(image,str):
            specs = effects_for(obj,props)
            # 全屏、合成、投影层取下方已绘制的画面再处理，单独渲染只会得到不透明的空白。
            if image.startswith("models/util/") and image!="models/util/solidlayer.json":
                if not any(kind=="clouds" for kind,_ in specs):
                    effects = sorted({kind for kind,_ in specs if kind not in {"color_grading"}})
                    motion = min(2.,max(.2,1+state["depth"]*.45))
                    if effects and captured and len(targets)==1 and targets[0]["kind"]!="particle" and targets[0]["motion"]==motion and targets[0]["id"] not in varying:
                        below = targets.pop()
                        targets.append({"id":obj["id"],"name":below["name"],"kind":"image","reason":"合成层","motion":motion,"members":[below["id"],*below.get("members",[])]})
                        continue
                    if effects:unsupported.append({"id":obj["id"],"name":name,"reason":"全屏后期效果 "+"、".join(effects)+" 无法逐层还原"})
                    hidden.append(obj["id"]);continue
                kind = "image"
            else:
                if image.startswith("models/util/") and any("audio_bars" in effect.get("file","").lower() for effect in obj.get("effects",[])):
                    continue
                if image!="models/util/solidlayer.json":
                    model = assets.json(image)
                    passes = assets.json(model["material"])["passes"]
                    # 视频图层由背屏视频元素播放。
                    if passes and passes[0].get("textures") and assets.is_video(passes[0]["textures"][0]):
                        captured = False;continue
                kind = "image"
        elif isinstance(obj.get("particle"),str) and obj["particle"]:
            descriptor = assets.json(obj["particle"])
            if any((point.get("flags",0) or 0)&1 for point in descriptor.get("controlpoint",[])):continue
            kind = "particle"
        elif "text" in obj and obj["id"] in clock_ids:
            hidden.append(obj["id"]);continue
        elif "text" in obj:
            kind = "text"
        else:
            continue
        # 与录制模式使用同一渲染器，默认画面一致；转换核心自己的近似渲染只在渲染器不可用时使用。
        targets.append({"id":obj["id"],"name":name,"kind":kind,"reason":"完整渲染","motion":min(2.,max(.2,1+state["depth"]*.45))})
    return {"targets":targets,"hidden":hidden,"unsupported":unsupported}


def config_for(draft, device):
    c = deepcopy(converter.DEFAULTS)
    layout, motion = draft["layout"], draft.get("motion", {})
    c.update({"预览宽度": device["width"], "预览高度": device["height"], "画面缩放": layout["scale"],
              "横向取景": layout["x"], "纵向取景": layout["y"], "避让左侧比例": device.get("safeLeft",.3),
              "显示秒": layout["clock"].get("seconds",False), "星期语言": "中文" if layout["clock"].get("language")=="zh" else "英文",
              "时制": layout["clock"].get("format","24"), "机型": device["name"],
              "感应幅度": motion.get("amount",.02), "感应灵敏度": motion.get("sensitivity",4),
              "平滑系数": motion.get("smoothing",.16), "纵向感应比例": motion.get("vertical",.3),
              "帧率": motion.get("fps",30), "时钟排版": deepcopy(layout["clock"]["rows"]),
              "视频音量": draft.get("properties",{}).get("__videoVolume",0),
              "时钟颜色": deepcopy(draft.get("appearance",{}).get("colors",{})),
              "导出画质": draft.get("export",{}).get("quality","standard")})
    return c


def baked_version(record):
    if record.get("empty"):return ["empty"]
    item=(Path(record["dir"])/"frames.rgba.gz").stat()
    return [record["dir"],record["count"],record["width"],record["height"],record["fps"],record["bbox"],item.st_size,item.st_mtime_ns]


def graphic_key(theme, draft, baked=None, time_variants=None):
    source = Path(theme["source"])
    stat = source.stat()
    file_versions={}
    for definition in theme.get("properties",[]):
        if definition.get("type") not in {"file","scenetexture"}:continue
        value=draft.get("properties",{}).get(definition["key"])
        if isinstance(value,str) and value:
            try:
                item=Path(value).stat();file_versions[definition["key"]]=[item.st_size,item.st_mtime_ns]
            except OSError:pass
    baked_versions={identifier:baked_version(record) for identifier,record in (baked or {}).items()}
    variants=None
    if time_variants:
        variants={"scenes":[digest(scene) for scene in time_variants["scenes"]],
                  "objects":{identifier:[{**variant,"baked":baked_version(variant["baked"]) if variant.get("baked") else None}
                                         for variant in records] for identifier,records in time_variants["objects"].items()}}
    identity={"version": CACHE_VERSION, "path": str(source), "mtime": stat.st_mtime_ns, "size": stat.st_size,"files":file_versions,"baked":baked_versions,
                   "timeVariants":variants,
                   "properties": draft.get("properties",{}), "layers": draft.get("layers",{}),
                   "clock": draft["layout"]["clock"]["enabled"], "engineRoots": theme.get("engineRoots",[]),"script":theme.get("scriptSignature")}
    if theme["type"] in {"video","scene"}:
        identity["fps"]=draft["motion"]["fps"]
    if theme["type"]=="video":
        identity.update(videoVersion=1,fps=draft["motion"]["fps"])
        identity.pop("clock")
        identity["properties"]={k:v for k,v in draft.get("properties",{}).items() if k!="__videoVolume"}
    return digest(identity)


def time_variant_scene(scene, worlds, properties, sw, sh, variants, baked, notes):
    # 先在原场景计算父子变换，再展开对象；渲染管线只会读取真正需要输出的状态。
    scenes=variants["scenes"]
    by_id=[{obj["id"]:obj for obj in item["objects"]} for item in scenes]
    transforms=[converter.world_transforms(item["objects"],properties,sw,sh,notes) for item in scenes]
    objects=[];worlds=dict(worlds)
    baked={identifier:record for identifier,record in baked.items() if identifier not in variants["objects"]}
    for obj in scene["objects"]:
        identifier=str(obj["id"])
        if identifier not in variants["objects"]:
            objects.append(obj)
            continue
        for index,variant in enumerate(variants["objects"][identifier]):
            state=transforms[variant["scene"]][obj["id"]]
            if state is None or state["alpha"]<=0:continue
            current=deepcopy(by_id[variant["scene"]][obj["id"]])
            current.update(id=f"{identifier}_t{index}",_time=deepcopy(variant["alpha"]),_time_index=index)
            objects.append(current);worlds[current["id"]]=state
            if variant.get("baked"):baked[current["id"]]=variant["baked"]
    return {**scene,"objects":objects},worlds,baked


def prepare_graphics(request, fast=False):
    theme, draft = request["theme"], request["draft"]
    baked=request.get("baked",{})
    time_variants=None if fast else request.get("timeVariants")
    key=graphic_key(theme,draft,baked,time_variants)
    root = Path(request["cacheRoot"])/"scenes"/key
    if fast and not (root/"场景.json").is_file():root=Path(request["cacheRoot"])/"previews"/key
    saved = root/"场景.json"
    if saved.is_file(): return root, json.loads(saved.read_text(encoding="utf-8"))
    root.parent.mkdir(parents=True, exist_ok=True)
    event("解析主题", 8)
    with tempfile.TemporaryDirectory(prefix="scene-", dir=request["scratchRoot"]) as scratch:
        stage = Path(scratch)/"data"
        (stage/"assets").mkdir(parents=True)
        config = config_for(draft,request["device"])
        if fast:config["纹理最长边"]=1280
        notes, details, background = [], {}, "#061633"
        if theme["type"] == "scene":
            data = loaded_scene(theme,draft)
            pkg,project,scene,sw,sh,props = data
            background = converter.scene_background(scene)
            worlds = converter.world_transforms(scene["objects"],props,sw,sh,notes)
            if time_variants:
                scene,worlds,baked=time_variant_scene(scene,worlds,props,sw,sh,time_variants,baked,notes)
            for obj in scene["objects"]:
                if "text" not in obj:continue
                raw = converter.value(obj.get("text"), "")
                if isinstance(raw,str) and clockwork.clock_roles(obj,raw): worlds[obj["id"]] = None
            media_root=Path(request["cacheRoot"])/"media"/digest([theme["source"],Path(theme["source"]).stat().st_mtime_ns])
            # 已烘焙的图层不再解码原材质；纯烘焙场景也可直接进入动效管线。
            native_objects=[obj for obj in scene["objects"] if str(obj["id"]) not in baked and (worlds.get(obj["id"]) or {}).get("alpha",0)>0
                            and isinstance(obj.get("image"),str) and obj["image"]
                            and (not obj["image"].startswith("models/util/") or obj["image"]=="models/util/solidlayer.json"
                                 and not any("audio_bars" in effect.get("file","").lower() for effect in obj.get("effects",[])))]
            if native_objects:
                native_data=(pkg,project,{**scene,"objects":native_objects},sw,sh,props)
                _,_,layers,layer_notes,name = converter.scene_layers(Path(theme["source"]),config,native_data,worlds,stage,media_root,fast)
                notes.extend(layer_notes)
            else:layers,name=[],project.get("title",Path(theme["source"]).parent.name)
            event("读取图层" if fast else "生成场景动效", 22)
            layers,restored,details = build_motion_scene(pkg,scene,props,layers,worlds,stage,converter.decode_tex,converter.layer_geometry,notes,fast=fast,fps=draft["motion"]["fps"],baked=baked)
            timed_objects=time_variants["objects"] if time_variants else {}
            details["时段变化"]={"对象数":len(timed_objects),"变体数":sum(len(records) for records in timed_objects.values())}
            if any(timed_objects.values()):restored.append("随时段变化")
            script_result=theme.get("scriptResult",{})
            if script_result.get("evaluated"):
                restored.append("脚本属性初始状态")
                notes.append("原场景脚本按当前设置解析初始状态；脚本事件与持续运行逻辑未迁移。")
            if script_result.get("errors"):
                notes.append(f"{len(script_result['errors'])} 处脚本未能解析，保留原值。")
                details["脚本兼容记录"]=script_result["errors"]
        elif theme["type"] == "image":
            sw,sh,layers,restored = converter.picture_layers(Path(theme["source"]),stage,config)
            name = theme["title"]
        elif theme["type"] == "video":
            from 视频处理 import metadata,poster,encode
            if fast:
                info=metadata(theme["source"]);original=info
                video_source=theme["source"]
            else:
                original=encode(theme["source"],stage/"assets/wallpaper.mp4",draft["motion"]["fps"],draft.get("properties",{}).get("__videoSpeed",1),event)
                info=metadata(stage/"assets/wallpaper.mp4");video_source=stage/"assets/wallpaper.mp4"
            sw,sh=info["source_size"]
            poster(video_source,stage/"assets/poster.jpg")
            layers=[{"id":"video","asset":"assets/poster.jpg",**({"videoSource":str(video_source)} if fast else {"video":"assets/wallpaper.mp4"}),"x":sw/2,"y":sh/2,"w":sw,"h":sh,"rotation":0,"motion":1}]
            restored=["视频播放"]
            details={"原视频尺寸":original.get("source_size"),"输出视频尺寸":[sw,sh],"时长":info.get("duration"),"帧率":info.get("fps")}
        else:
            raise ValueError("此类主题的背屏转换尚未接入。")
        clean = [{k:v for k,v in layer.items() if k not in {"image","native_size","atlas","puppet"}} for layer in layers]
        if not clean: raise ValueError("主题中没有可输出的画面图层。")
        payload = {"width":sw,"height":sh,"title":theme["title"],"layers":clean,"restored":restored,"notes":list(dict.fromkeys(notes)),"details":details,"progressive":fast and theme["type"]!="image","background":background}
        atomic_json(stage/"场景.json",payload)
        commit_cache(stage,root,"场景.json")
    return root,payload


def flat_scene(theme):
    try:
        converter.read_scene(Path(theme["source"]))
        return True
    except ValueError:
        return False


def selected_clock_fonts(theme,draft):
    explicit = draft.get("appearance",{}).get("fonts",{})
    if theme["type"] == "scene" and flat_scene(theme):
        pkg,_,scene,sw,sh,props = loaded_scene(theme,draft)
        worlds = converter.world_transforms(scene["objects"],props,sw,sh,[])
        original_theme={k:v for k,v in theme.items() if k not in {"resolvedScene","scriptResult"}}
        original_pkg,_,original_scene,ow,oh,original_props = loaded_scene(original_theme,{})
        original_worlds=converter.world_transforms(original_scene["objects"],original_props,ow,oh,[])
        _,original_roles=clockwork.theme_font_sources(original_scene["objects"],original_worlds,original_props)
        _,current_roles=clockwork.theme_font_sources(scene["objects"],worlds,props)
        clock_ids={entry["编号"] for role,fonts in original_roles.items() if not current_roles[role] for entries in fonts.values() for entry in entries}
        for identifier in clock_ids:
            if worlds.get(identifier) is None:worlds[identifier]={"alpha":1}
        selected = None
        try: selected = clockwork.select_fonts(pkg,scene["objects"],worlds,props)
        except ValueError:
            # 原时钟被用户隐藏时只回溯原场景默认可见项，不混入隐藏媒体卡的字体。
            try:selected=clockwork.select_fonts(original_pkg,original_scene["objects"],original_worlds,original_props)
            except ValueError:
                if not all(explicit.get(k) for k in ROLE_KEYS.values()): raise
                selected = {}
    else:
        pkg, selected = None, {}
    for role,key in ROLE_KEYS.items():
        choice = explicit.get(key,"")
        if not choice:
            if role not in selected: raise ValueError("请选择时钟字体。")
            continue
        if choice.startswith("theme:") and pkg is not None:
            data = pkg.read(choice[6:])
        else:
            data = clockwork.read_font_data(Path(choice))
        old = selected.get(role,(None,{}))[1]
        selected[role] = (data,{**old,"字体文件":choice,"选取规则":"用户明确指定"})
    return selected


def prepare_clock(request,config):
    if not request["draft"]["layout"]["clock"]["enabled"]: return None,None
    theme,draft = request["theme"],request["draft"]
    selected = selected_clock_fonts(theme,draft)
    if theme["type"]=="scene" and flat_scene(theme):
        pkg,_,scene,w,h,props=loaded_scene(theme,draft)
        worlds=converter.world_transforms(scene["objects"],props,w,h,[])
        candidates={key:[] for key in ROLE_KEYS.values()}
        for obj in scene["objects"]:
            if "text" not in obj:continue
            raw=converter.value(obj.get("text"),"")
            if not isinstance(raw,str):continue
            for role in clockwork.clock_roles(obj,raw):candidates[ROLE_KEYS[role]].append((obj,raw))
        for key,entries in candidates.items():
            if entries:
                active=[(obj,text) for obj,text in entries if worlds.get(obj["id"]) is not None and text.strip()]
                config["时钟排版"][key]["sourceVisible"]=bool(active)
                config["时钟排版"][key]["visible"]=config["时钟排版"][key]["visible"] and bool(active)
                if key=="time" and draft["layout"]["clock"].get("format")=="auto" and active:
                    source_format=theme.get("scriptResult",{}).get("clockFormats",{}).get(str(active[0][0]["id"]))
                    visible_text=active[0][1]
                    hour_match=re.search(r'(?<!\d)(\d{1,2})[:：]\d{2}',visible_text)
                    if source_format:config["时制"]=source_format
                    elif hour_match and datetime.now().hour>12 and int(hour_match[1])==datetime.now().hour%12:config["时制"]="12"
                    elif re.search(r'\b[AP]M\b',visible_text,re.I):config["时制"]="12"
                    else:config["时制"]="24"
    key = digest({"version":CACHE_VERSION,"font":[sha256(x[0]).hexdigest() for x in selected.values()],
                  "sources":[x[1] for x in selected.values()],"config":config})
    root = Path(request["cacheRoot"])/"clocks"/key
    file = root/"字形.json"
    if file.is_file(): return root,json.loads(file.read_text(encoding="utf-8"))
    root.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="clock-",dir=request["scratchRoot"]) as temp:
        stage=Path(temp)/"data"; (stage/"assets").mkdir(parents=True)
        clock = clockwork.build_clock(stage,config,selected)
        atomic_json(stage/"字形.json",clock)
        commit_cache(stage,root,"字形.json")
    return root,clock


def prepare_recording(request):
    """完整画面的录制结果作为整幅视频图层；取景已在录制时完成，感应时整幅位移。"""
    from 视频处理 import poster
    recording = request["recording"]
    root = Path(request["scratchRoot"])/"recorded"
    (root/"assets").mkdir(parents=True, exist_ok=True)
    shutil.copy2(recording["path"], root/"assets/wallpaper.mp4")
    poster(root/"assets/wallpaper.mp4", root/"assets/poster.jpg")
    sw, sh = recording["width"], recording["height"]
    layers = [{"id":"video","asset":"assets/poster.jpg","video":"assets/wallpaper.mp4","x":sw/2,"y":sh/2,"w":sw,"h":sh,"rotation":0,"motion":1}]
    notes = ["完整画面按录制时长循环播放；音频响应、鼠标交互和持续变化的脚本按录制时段固定。"]
    details = {"渲染方式":"完整画面录制","录制尺寸":[sw,sh],"帧率":recording["fps"],"时长":recording["duration"],"循环过渡":recording.get("fade",0)}
    return root, {"width":sw,"height":sh,"title":request["theme"]["title"],"layers":layers,"restored":["完整画面"],"notes":notes,"details":details}


def prepare(request, fast=False):
    recorded = bool(request.get("recording"))
    root,payload = prepare_recording(request) if recorded else prepare_graphics(request,fast=fast)
    event("更新排版",94 if recorded or request["theme"]["type"]=="video" else 85)
    config = config_for(request["draft"],request["device"])
    if recorded:config.update({"画面缩放":1,"横向取景":.5,"纵向取景":.5})
    try:clock_root,clock = prepare_clock(request,config)
    except ValueError as exc:
        if request.get("operation")=="export":raise
        clock_root,clock=None,None
        payload={**payload,"clockError":str(exc)}
    result={**payload,"config":config,"clock":clock,"assetRoot":str(root),"clockRoot":str(clock_root) if clock_root else None}
    if request["theme"]["type"]=="video":
        result["videoSpeed"]=1 if payload.get("progressive") else request["draft"].get("properties",{}).get("__videoSpeed",1)
    return result


def export(request):
    payload = prepare(request)
    destination = Path(request["outputDirectory"])
    destination.mkdir(parents=True,exist_ok=True)
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]',"_",request["theme"]["title"]).strip(". ")[:70] or "壁纸"
    device = request["device"]["name"]
    folder = destination/(title+" · "+device+" · "+datetime.now().strftime("%m%d-%H%M%S-%f"))
    with tempfile.TemporaryDirectory(prefix="render-",dir=request.get("exportStagingRoot") or destination) as temp:
        stage = Path(temp)/"成品";stage.mkdir()
        shutil.copytree(Path(payload["assetRoot"])/"assets",stage/"assets")
        if payload["clockRoot"]:
            for file in (Path(payload["clockRoot"])/"assets").iterdir():shutil.copy2(file,stage/"assets"/file.name)
        layers = deepcopy(payload["layers"])
        # 按背屏实际显示尺寸裁切与缩小贴图、视频，2K/4K 素材超出的像素在背屏上不可见。
        event("压缩资源",90)
        from 画质压缩 import fit_layers
        compression = fit_layers(stage,layers,payload["config"],payload["width"],payload["height"])
        event("生成背屏包",94)
        for layer in layers:
            with Image.open(stage/layer["asset"]) as im:layer["image"] = im.convert("RGBA")
        package,report = converter.write_product(stage,payload["width"],payload["height"],layers,payload["config"],
            request["theme"]["title"],payload["restored"],payload["notes"],payload["details"],request["theme"]["type"],payload["clock"],payload.get("background","#061633"))
        report.update({"目标":device,"输出尺寸":[request["device"]["width"],request["device"]["height"]],
                       "主题设置":request["draft"].get("properties",{}),"排版":request["draft"]["layout"]})
        report["效果详情"]["导出压缩"]={**compression,"画质":payload["config"]["导出画质"]}
        atomic_json(stage/"转换报告.json",report)
        result={"path":str(folder/package.name),"folder":str(folder),"notes":len(report.get("未迁移及注意事项",[])),"size":package.stat().st_size}
        atomic_json(Path(request["scratchRoot"])/"job-result.json",result)
        os.replace(stage,folder)
    return result


def list_fonts():
    if sys.platform == "win32":
        roots = [Path(os.environ.get("WINDIR","C:/Windows"))/"Fonts",Path(os.environ.get("LOCALAPPDATA",""))/"Microsoft/Windows/Fonts"]
    else:
        roots = [Path("/usr/share/fonts"),Path.home()/".fonts",Path.home()/".local/share/fonts"]
    fonts,seen = [],set()
    for root in roots:
        if not root.is_dir():continue
        for path in root.rglob("*"):
            if path.suffix.lower() not in {".ttf",".otf",".ttc"}:continue
            key = str(path.resolve())
            if key in seen:continue
            seen.add(key)
            try:
                with TTFont(path,fontNumber=0,lazy=True) as font:
                    label = font["name"].getDebugName(4) or path.stem
                fonts.append({"value":str(path),"label":label})
            except Exception:pass
    return sorted(fonts,key=lambda x:x["label"].casefold())


def main():
    for stream in (sys.stdin,sys.stdout,sys.stderr):
        if hasattr(stream,"reconfigure"):stream.reconfigure(encoding="utf-8")
    request = json.loads(sys.stdin.readline())
    operation = request.get("operation")
    if operation in {"preview","motion-preview","export","clock"}:
        Path(request["cacheRoot"]).mkdir(parents=True,exist_ok=True)
        Path(request["scratchRoot"]).mkdir(parents=True,exist_ok=True)
    if operation == "script-input":
        _,_,scene,width,height,properties=loaded_scene(request["theme"],request["draft"])
        clock_ids=[obj["id"] for obj in scene["objects"] if "text" in obj and isinstance(converter.value(obj.get("text"),""),str) and clockwork.clock_roles(obj,converter.value(obj.get("text"),""))]
        result={"scene":scene,"width":width,"height":height,"properties":properties,"clockLayerIds":clock_ids}
    elif operation == "inspect": result = inspect_theme(request)
    elif operation == "layer-plans":
        result = [layer_plan({**request,"theme":{**request["theme"],"resolvedScene":scene}}) for scene in request["scenes"]]
    elif operation == "fonts": result = list_fonts()
    elif operation == "ffmpeg":
        import imageio_ffmpeg
        result = {"path": imageio_ffmpeg.get_ffmpeg_exe()}
    elif operation == "preview": result = prepare(request,fast=True)
    elif operation == "motion-preview": result = prepare(request)
    elif operation == "export": result = export(request)
    elif operation == "clock":
        config=config_for(request["draft"],request["device"])
        root,clock=prepare_clock(request,config)
        result={"clock":clock,"clockRoot":str(root) if root else None,"config":config}
    else: raise ValueError("未知操作。")
    print(json.dumps({"event":"result","result":result},ensure_ascii=False,allow_nan=False),flush=True)


if __name__ == "__main__":
    try:main()
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"event":"error","message":str(exc)},ensure_ascii=False),flush=True)
        raise SystemExit(1)
