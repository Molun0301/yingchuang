import importlib.util
import io
import os
import json
from hashlib import sha256
import math
from pathlib import Path
import random
import shutil
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

import pytest
from PIL import Image, ImageChops

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "core"))
SPEC = importlib.util.spec_from_file_location("rear_converter", BASE / "core/背屏转换.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
from 背屏时钟 import select_fonts, build_clock
from 场景动效 import SceneAssets, coords, shake_displacement, particle_spawn
SOURCE = Path(os.environ.get('YINGCHUANG_TEST_THEME', str(Path.home()/'.local/share/Steam/steamapps/workshop/content/431960/3352465485'))) / 'scene.pkg'
pytestmark = pytest.mark.skipif(not SOURCE.is_file(), reason='本机没有猫猫回归样例')


@pytest.fixture(scope="module")
def cat():
    config = M.load_config(BASE / "core/配置.json")
    return (*M.scene_layers(SOURCE, config), config)


def test_original_assets_and_transparency(cat):
    sw, sh, layers, notes, title, config = cat
    assert (sw, sh) == (3840, 2160)
    assert [x['id'] for x in layers] == [16, 74, 66, 57, 53, 31, 52, 47, 42]
    source = M.Package(SOURCE)
    texture = source.read('materials/107236405_p2 (1)bg_bg_fg.tex')
    texture_start = texture.index(b'\x89PNG\r\n\x1a\n')
    original = Image.open(io.BytesIO(texture[texture_start:])).convert('RGBA')
    converted = next(x['image'] for x in layers if x['id'] == 47)
    assert converted.size == (440, 525)
    assert original.tobytes() == converted.tobytes()
    assert converted.getchannel('A').getextrema() == (0, 255)
    assert layers[0]['image'].getchannel('A').getextrema() == (255, 255)
    assert next(x for x in layers if x['id'] == 47)['puppet'].endswith('.mdl')


@pytest.mark.parametrize('width,height', [(976,596), (904,596), (1080,660), (596,976)])
@pytest.mark.parametrize('focus', [0, .5, 1])
def test_edges_stay_covered_at_maximum_tilt(cat, width, height, focus):
    sw, sh, layers, notes, title, c = cat
    c = dict(c, 横向取景=focus, 纵向取景=focus)
    for dx in [-1, 1]:
        for dy in [-1, 1]:
            first = M.geometry(sw, sh, layers, c, width, height, dx, dy)[0]
            assert first['x'] - first['w']/2 <= 1e-7
            assert first['x'] + first['w']/2 >= width - 1e-7
            assert first['y'] - first['h']/2 <= 1e-7
            assert first['y'] + first['h']/2 >= height - 1e-7


def test_foreground_and_background_have_distinct_parallax(cat):
    sw, sh, layers, notes, title, c = cat
    zero = M.geometry(sw, sh, layers, c, 976, 596)
    tilted = M.geometry(sw, sh, layers, c, 976, 596, 1, 1)
    delta = {l['id']: (b['x']-a['x'], b['y']-a['y']) for l,a,b in zip(layers,zero,tilted)}
    assert delta[47][0] > delta[16][0] * 3
    assert all(abs(x) < 40 and abs(y) < 8 for x,y in delta.values())


def test_reareye_archive_entry_and_metadata_contract(tmp_path, cat):
    src = tmp_path/'测试原图.png'
    Image.new('RGB', (300, 200), '#123456').save(src)
    c = cat[-1]
    font = tmp_path/'指定字体.otf'
    font.write_bytes(M.Package(SOURCE).read('fonts/Garet-Book.otf'))
    package, report = M.convert(src, tmp_path/'新的成品', c, '测试</script>壁纸', {'全部': font})
    assert all(row['选取规则'] == '用户明确指定' for row in report['字体来源'].values())
    with zipfile.ZipFile(package) as z:
        assert z.testzip() is None
        root = ET.fromstring(z.read('manifest.xml'))
        assert root.tag == 'Widget'
        assert root.find('.//SensorBinder').get('type') == 'gravity'
        assert root.get('useVariableUpdater') == 'DateTime.Minute'
        assert root.find('.//Trigger[@action="resume"]') is not None
        clock = root.find("./Group[@name='clock']")
        assert clock.get('y') == '#view_height/2'
        assert [line.get('name') for line in clock] == ['clock_week','clock_date','clock_time']
        assert all(x.get('fontFamily') is None for x in root.iter())
        assert 'assets/clock_time_num_9.png' in z.namelist()
        meta = json.loads(z.read('metadata.mrm'))
        assert meta['titles']['zh_CN'] == '测试</script>壁纸 · 感应背屏'
        assert meta['isThirdParties'] is True
        config = ET.fromstring(z.read('var_config.xml'))
        assert config.tag == 'WidgetConfig'
        assert config.find('./ImageSelect/item').text in z.namelist()
    preview = (package.parent/'交互预览.html').read_text()
    assert '</script>壁纸' not in preview
    old_data = package.read_bytes()
    with pytest.raises(M.ConversionError, match='输出目录已存在'):
        M.convert(src, package.parent, c)
    assert package.read_bytes() == old_data


def test_truncated_and_unsafe_packages_rejected(tmp_path):
    pkg = tmp_path/'scene.pkg'
    pkg.write_bytes(struct.pack('<I',8)+b'PKGV0021'+struct.pack('<I',1))
    with pytest.raises(M.ConversionError, match='截断'):
        M.Package(pkg)
    name = b'../../outside'
    pkg.write_bytes(struct.pack('<I',8)+b'PKGV0021'+struct.pack('<II',1,len(name))+name+struct.pack('<II',0,0))
    with pytest.raises(M.ConversionError, match='路径无效'):
        M.Package(pkg)


@pytest.mark.parametrize('fmt,payload,expected', [(0,b'\x0a\x14\x1e\xff',(10,20,30,255)), (9,b'\x11',(17,17,17,255)), (7,b'\x00\xf8\x00\x00'+b'\0'*4,(255,0,0,255))])
def test_raw_texture_decoding(fmt,payload,expected):
    w=h=4 if fmt == 7 else 1
    header=b'TEXV0005\0TEXI0001\0'+struct.pack('<7i',fmt,2,w,h,w,h,0)+b'TEXB0002\0'
    data=header+struct.pack('<7I',1,1,w,h,0,len(payload),len(payload))+payload
    image=M.decode_tex(data)
    assert image.size==(w,h)
    assert image.getpixel((0,0))==expected


def test_compressed_texture_decoding():
    import lz4.block
    payload=b'\x0a\x14\x1e\xff'
    compressed=lz4.block.compress(payload,store_size=False)
    data=b'TEXV0005\0TEXI0001\0'+struct.pack('<7i',0,2,1,1,1,1,0)+b'TEXB0002\0'
    data+=struct.pack('<7I',1,1,1,1,1,len(payload),len(compressed))+compressed
    assert M.decode_tex(data).getpixel((0,0))==(10,20,30,255)


def test_invalid_configuration_fails_before_output(tmp_path):
    cfg=tmp_path/'配置.json'
    for bad in [{'感应幅度':float('nan')}, {'预览高度':596.5}, {'横向方向':0}, {'文字中心位置':.3}, {'文字颜色':'red'}]:
        cfg.write_text(json.dumps(bad),encoding='utf-8')
        with pytest.raises(M.ConversionError):M.load_config(cfg)


def test_unpacked_scene_uses_generic_effect_and_parent_transform(tmp_path):
    source = tmp_path / '工程'
    (source / 'materials').mkdir(parents=True)
    (source / 'models').mkdir()
    (source / 'fonts').mkdir()
    names = ['DejaVuSans.ttf', 'DejaVuSerif.ttf', 'DejaVuSansMono.ttf']
    for name in names:
        shutil.copyfile(Path('/usr/share/fonts/truetype/dejavu')/name, source/'fonts'/name)
    image = Image.linear_gradient('L').resize((256, 128)).convert('RGB')
    image.save(source / 'materials/任意原图.png')
    (source / 'models/任意模型.json').write_text(
        json.dumps({'material':'materials/任意材质.json'}, ensure_ascii=False))
    (source / 'materials/任意材质.json').write_text(json.dumps({'passes':[
        {'shader':'genericimage4','textures':['任意原图.png']}]},ensure_ascii=False))
    scene = {'general':{'orthogonalprojection':{'width':256,'height':128}},'objects':[
        {'id':968,'origin':'128 64 0','scale':'1 1 1'},
        {'id':991,'name':'任意图层','parent':968,'origin':'5 0 0',
         'image':'models/任意模型.json','size':'256 128',
         'effects':[{'file':'effects/waterwaves/effect.json','passes':[{'constantshadervalues':
                      {'strength':.2,'direction':1,'scale':10,'speed':2}}]},
                    {'file':'effects/unrecognized/effect.json'}]},
        *[{'id':1010+i,'name':role,'text':sample,'font':'fonts/'+font}
          for i,(role,sample,font) in enumerate(zip(
              ['weekday','date','clock'],['FRIDAY','2026.11.06','17:30'],names))]]}
    (source/'scene.json').write_text(json.dumps(scene,ensure_ascii=False))
    (source/'project.json').write_text(json.dumps({'type':'Scene','file':'scene.json','title':'通用样本'}))
    result, report=M.convert(source,tmp_path/'成品',M.load_config(None))
    assert 'waterwaves' in report['恢复效果']
    assert any('unrecognized' in note for note in report['未迁移及注意事项'])
    assert [report['字体来源'][role]['字体文件'] for role in ('星期','日期','时间')] == ['fonts/'+name for name in names]
    assert all(report['字体来源'][role]['SHA-256'] == sha256((source/'fonts'/name).read_bytes()).hexdigest()
               for role,name in zip(('星期','日期','时间'),names))
    with zipfile.ZipFile(result) as z:
        manifest=ET.fromstring(z.read('manifest.xml'))
        layer=manifest.find(".//Image[@name='layer_991']")
        assert '+133*#scene_scale' in layer.get('x')
        frames=layer.findall('./SourcesAnimation/Source')
        a=Image.open(io.BytesIO(z.read(frames[0].get('src')))).convert('RGB')
        b=Image.open(io.BytesIO(z.read(frames[len(frames)//3].get('src')))).convert('RGB')
        assert ImageChops.difference(a,b).getbbox()
        clock=manifest.find("./Group[@name='clock']")
        assert [node.get('name') for node in clock]==['clock_week','clock_date','clock_time']
        assert not any(manifest.find(f"./Image[@name='layer_{i}']") is not None for i in range(1010,1013))


def test_animated_image_preserves_non_uniform_frame_times(tmp_path):
    source=tmp_path/'动画.gif'
    frames=[Image.new('RGB',(48,32),color) for color in ('red','green','blue')]
    frames[0].save(source,save_all=True,append_images=frames[1:],duration=[70,150,80],loop=0)
    fallback,report=M.convert(source,tmp_path/'未指定字体',M.load_config(None))
    assert fallback.is_file() and '时间' in report['字体来源']
    assert any('已临时改用' in note for note in report['未迁移及注意事项'])
    result,report=M.convert(source,tmp_path/'动画成品',M.load_config(None),no_clock=True)
    assert report['恢复效果']==['图片帧动画']
    with zipfile.ZipFile(result) as z:
        root=ET.fromstring(z.read('manifest.xml'))
        frames=root.findall('.//SourcesAnimation/Source')
        assert [int(frame.get('time')) for frame in frames]==[0,70,220,300]
        assert root.find("./Group[@name='clock']") is None


def test_cat_fonts_match_visible_source_and_clock_ink_is_centered(tmp_path, cat):
    pkg,_,scene,sw,sh,props=M.read_scene(SOURCE)
    worlds=M.world_transforms(scene['objects'],props,sw,sh,[])
    selected=select_fonts(pkg,scene['objects'],worlds,props)
    (tmp_path/'assets').mkdir()
    config=cat[-1]
    clock=build_clock(tmp_path,config,selected)
    assert [clock['fonts'][role]['源图层'][0]['编号'] for role in ('星期','日期','时间')] == [154412,154418,154405]
    digest=sha256(pkg.read('fonts/Garet-Book.otf')).hexdigest()
    assert all(record['SHA-256'] == digest and record['字体内名'] == 'Garet Book'
               for record in clock['fonts'].values())
    x,y,unit=M.clock_geometry(config,clock,976,596)
    top,bottom=clock['rows'][0],clock['rows'][-1]
    assert x == pytest.approx(976*.74)
    assert y == 298 and unit == 1
    assert top['y']-top['h']/2 == -(bottom['y']+bottom['h']/2)
    with Image.open(tmp_path/'assets/clock_time_num_7.png') as ink:
        assert {pixel[:3] for pixel in ink.getdata() if pixel[3]} == {(10,25,30)}


def test_ambiguous_clock_font_selects_source_with_warning(tmp_path):
    objects=[{'id':i,'name':role,'text':sample,'font':font}
             for i, (role,sample,font) in enumerate([
                 ('weekday','FRIDAY','fonts/a.otf'),('date','2026.11.06','fonts/a.otf'),
                 ('clock','17:29','fonts/a.otf'),('clock','05:29','fonts/b.otf')])]
    folder=M.SceneFolder(tmp_path/'scene.json')
    (tmp_path/'fonts').mkdir()
    (tmp_path/'fonts/a.otf').write_bytes(M.Package(SOURCE).read('fonts/Garet-Book.otf'))
    (tmp_path/'fonts/b.otf').write_bytes(M.Package(SOURCE).read('fonts/Harukaze.otf'))
    selected=select_fonts(folder,objects,{i:{'alpha':1} for i in range(4)},{})
    assert selected['时间'][0]==(tmp_path/'fonts/a.otf').read_bytes()
    assert '多个字体' in selected['时间'][1]['提醒']
    (tmp_path/'assets').mkdir()
    clock=build_clock(tmp_path,M.load_config(None),selected)
    assert any(row['key']=='time' for row in clock['rows'])
    assert any(warning['key']=='time' and '多个字体' in warning['message'] for warning in clock['warnings'])


def test_rg88_light_uses_green_for_opacity_but_shake_uses_signed_directions(tmp_path):
    # 相同的贴图通道在光束颜色与摇摆方向中的含义不同。
    material_dir = tmp_path / 'materials'
    material_dir.mkdir()
    header = b'TEXV0005\0TEXI0001\0' + struct.pack('<7i',8,2,2,1,2,1,0) + b'TEXB0002\0'
    layout = struct.pack('<7I',1,1,2,1,0,4,4)
    (material_dir/'light.tex').write_bytes(header+layout+bytes([255,0,255,128]))
    (material_dir/'flow.tex').write_bytes(header+layout+bytes([127,127,127,255]))
    assets = SceneAssets(M.SceneFolder(tmp_path/'scene.json'), None, M.decode_tex)
    light = assets.texture('light', albedo=True)
    assert light.getpixel((0,0)) == (255,255,255,0)
    assert light.getpixel((1,0)) == (255,255,255,128)
    assert assets.texture('flow').getpixel((1,0))[:2] == (127,255)
    spec = {'textures':[None,'flow'], 'values':{'speed':1,'strength':.1}, 'combos':{}}
    u,v = coords((2,1))
    motion = shake_displacement(assets,spec,(2,1),u,v)
    dx,dy = motion(math.pi/2)
    assert not dx.any()
    assert dy[0,0] == 0 and dy[0,1] == pytest.approx(.01, rel=.01)
    assert motion(3*math.pi/2)[1][0,1] < -.009


def test_snow_emitter_preserves_thin_spawn_band_and_centered_box():
    rng = random.Random(91)
    snow = {'name':'sphererandom','distancemax':1000,'directions':'1 .03 1'}
    offsets = [particle_spawn(rng,snow,1920) for _ in range(100)]
    assert max(abs(point[1]) for point in offsets) <= 30
    assert min(point[0] for point in offsets) < -500 < 500 < max(point[0] for point in offsets)
    box = {'name':'boxrandom','distancemax':'1920 1080 0'}
    offsets = [particle_spawn(rng,box,1920) for _ in range(50)]
    assert min(point[0] for point in offsets) < 0 < max(point[0] for point in offsets)
