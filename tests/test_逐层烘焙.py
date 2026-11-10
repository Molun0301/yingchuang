"""独立场景验证逐层规划、透明帧替换与背屏动画预算。"""
from copy import deepcopy
from io import StringIO
import gzip
import json
import os
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

import pytest
from PIL import Image,ImageDraw

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'core'))
import 应用桥接 as bridge
import 场景动效 as motion


def write_json(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')


@pytest.fixture
def scene_request(tmp_path):
    source=tmp_path/'主题'
    write_json(source/'project.json',{'title':'逐层样例','type':'scene','file':'scene.json'})
    write_json(source/'models/picture.json',{'material':'materials/picture.json'})
    write_json(source/'materials/picture.json',{'passes':[{'shader':'genericimage4','textures':['picture.png']}]})
    Image.new('RGBA',(64,48),'#345678').save(source/'materials/picture.png')
    write_json(source/'scene.json',{'general':{'orthogonalprojection':{'width':64,'height':48}},'objects':[
        {'id':1,'name':'普通图层','image':'models/picture.json','origin':'32 24 0','size':'64 48'},
        {'id':2,'name':'水波图层','image':'models/picture.json','origin':'20 30 0','size':'20 16','parallaxDepth':'2 0',
         'effects':[{'file':'effects/waterripple/effect.json'}]},
        {'id':3,'name':'全屏后期','image':'models/util/fullscreenlayer.json',
         'effects':[{'file':'effects/color_grading/effect.json'},{'file':'effects/bloom/effect.json'}]},
        {'id':4,'name':'文字','text':'12:34'}]})
    scratch=tmp_path/'工作';scratch.mkdir()
    return {'operation':'layer-plan','theme':{'type':'scene','title':'逐层样例','source':str(source/'scene.json'),'engineRoots':[]},
            'draft':{'layout':{'scale':1,'x':.5,'y':.5,'clock':{'enabled':False,'rows':{}}},
                     'motion':{'fps':30},'properties':{},'layers':{}},
            'device':{'name':'测试背屏','width':320,'height':240},'cacheRoot':str(tmp_path/'缓存'),
            'scratchRoot':str(scratch),'outputDirectory':str(tmp_path/'成品')}


def edit_scene(request):
    return json.loads(Path(request['theme']['source']).read_text(encoding='utf-8'))


def save_scene(request,scene):
    write_json(Path(request['theme']['source']),scene)


def baked_frames(tmp_path,name,static=False,size=(40,30),count=20,bbox=(7,11,24,18)):
    folder=tmp_path/name;folder.mkdir()
    with gzip.open(folder/'frames.rgba.gz','wb') as stream:
        for index in range(count):
            image=Image.new('RGBA',size)
            w,h=max(8,size[0]//4),max(8,size[1]//4)
            x=0 if static else index%(size[0]-w)
            ImageDraw.Draw(image).rectangle((x,0,x+w-1,h-1),fill=(80,120,160,128))
            stream.write(image.tobytes())
    return {'dir':str(folder),'width':size[0],'height':size[1],'count':count,'fps':10.,'bbox':list(bbox)}


def test_layer_plan_main_reports_targets_hidden_and_unsupported(scene_request,monkeypatch):
    output=StringIO()
    monkeypatch.setattr(sys,'stdin',StringIO(json.dumps({**scene_request,'operation':'layer-plans','scenes':[None]})))
    monkeypatch.setattr(sys,'stdout',output)
    bridge.main()
    [result]=json.loads(output.getvalue())['result']
    # 所有可见图层都逐层渲染（与录制模式同一渲染器），全屏后期层与原时钟文字隐藏。
    assert result['targets']==[{'id':1,'name':'普通图层','kind':'image','reason':'完整渲染','motion':1.0},
                               {'id':2,'name':'水波图层','kind':'image','reason':'完整渲染','motion':1.9}]
    assert result['hidden']==[3,4]
    assert result['unsupported']==[{'id':3,'name':'全屏后期','reason':'全屏后期效果 bloom 无法逐层还原'}]


def test_layer_plan_includes_every_visible_layer_kind(scene_request):
    scene=edit_scene(scene_request)
    write_json(Path(scene_request['theme']['source']).parent/'particles/snow.json',{'emitter':[{'name':'boxrandom'}],'renderer':[{'name':'sprite'}]})
    write_json(Path(scene_request['theme']['source']).parent/'particles/mouse.json',{'emitter':[{'name':'boxrandom'}],'controlpoint':[{'flags':1}]})
    scene['objects']+=[{'id':5,'name':'雪','particle':'particles/snow.json'},{'id':6,'name':'跟随鼠标','particle':'particles/mouse.json'},
                       {'id':7,'name':'标题','text':'你好'},{'id':8,'name':'隐藏','image':'models/picture.json','visible':False},
                       {'id':9,'name':'投影层','image':'models/util/projectlayer.json','effects':[{'file':'effects/blur/effect.json'}]},
                       {'id':10,'name':'雾','image':'models/util/fullscreenlayer.json','effects':[{'file':'effects/clouds/effect.json'}]}]
    save_scene(scene_request,scene)
    plan=bridge.layer_plan(scene_request)
    assert [(t['id'],t['kind']) for t in plan['targets']]==[(1,'image'),(2,'image'),(5,'particle'),(7,'text'),(10,'image')]
    assert plan['hidden']==[3,4,9]
    assert {u['id'] for u in plan['unsupported']}=={3,9}


def test_layer_plan_merges_composition_layer_with_single_layer_below(scene_request):
    scene=edit_scene(scene_request)
    # 只处理背景的模糊合成层与背景合成一层渲染；下方有多个图层的全屏后期层仍隐藏。
    scene['objects'].insert(1,{'id':9,'name':'背景模糊','image':'models/util/projectlayer.json','effects':[{'file':'effects/blur/effect.json'}]})
    save_scene(scene_request,scene)
    plan=bridge.layer_plan(scene_request)
    assert plan['targets'][0]=={'id':9,'name':'普通图层','kind':'image','reason':'合成层','motion':1.0,'members':[1]}
    assert [t['id'] for t in plan['targets']]==[9,2]
    assert plan['hidden']==[3,4]
    # 随时段变化的图层不并入合成层。
    assert [t['id'] for t in bridge.layer_plan({**scene_request,'varying':[1]})['targets']]==[1,2]


def test_layer_plan_keeps_video_textures_out_of_baking(scene_request):
    source=Path(scene_request['theme']['source']).parent
    (source/'materials/video.tex').write_bytes(b'TEXV0005\0TEXI0001\0'+struct.pack('<7i',0,34,64,48,64,48,0))
    write_json(source/'materials/picture.json',{'passes':[{'shader':'customimage','textures':['video.tex']}]})
    assert bridge.layer_plan(scene_request)['targets']==[]


def test_layer_plan_rejects_non_orthographic_scene(scene_request):
    scene=edit_scene(scene_request);scene['general']={};save_scene(scene_request,scene)
    with pytest.raises(ValueError,match='正交画布'):
        bridge.layer_plan(scene_request)


@pytest.mark.parametrize('kind',['image','particle'])
def test_baked_frames_replace_layers_and_export_with_bbox(scene_request,tmp_path,kind,monkeypatch):
    # 本测试核对烘焙帧本身的几何，导出压缩的裁切由 test_画质压缩.py 覆盖。
    import 画质压缩;monkeypatch.setattr(画质压缩,'fit_layers',lambda *args:{})
    scene=edit_scene(scene_request)
    # 原材质不存在也不应读取；粒子也无需经过原生贴图转换。
    scene['objects'][0]['image']='models/baked-only.json'
    scene['objects'][1].pop('image')
    scene['objects'][1][kind]='models/baked-only.json' if kind=='image' else 'particles/baked-only.json'
    scene['objects'][1].update(alpha=.3,color='.4 .5 .6',angles='0 0 .4',scale='-1 1 1')
    save_scene(scene_request,scene)
    scene_request['baked']={'1':baked_frames(tmp_path,'静态',static=True),
                            '2':baked_frames(tmp_path,'动态',bbox=(-3,5,38,26))}
    root,payload=bridge.prepare_graphics(scene_request)
    static,dynamic=payload['layers']
    assert [layer['id'] for layer in payload['layers']]==[1,2]
    assert 'sequence' not in static and len(list((root/'assets').glob(Path(static['asset']).stem+'*')))==1
    assert {key:dynamic[key] for key in ('x','y','w','h','rotation','flip_y','opacity','color')}=={
        'x':16,'y':18,'w':38,'h':26,'rotation':0,'flip_y':False,'opacity':1,'color':[1,1,1]}
    assert dynamic['motion']==1.9 and dynamic['source_depth']==2
    assert len(dynamic['sequence']['frames'])==20 and dynamic['sequence']['period']==2000
    assert len(list((root/'assets').iterdir()))==21
    assert '逐层完整渲染' in payload['restored']
    with Image.open(root/dynamic['asset']) as image:
        assert image.size==(40,30) and image.convert('RGBA').getchannel('A').getextrema()==(0,128)
    scene_request['operation']='export'
    result=bridge.export(scene_request)
    with zipfile.ZipFile(result['path']) as package:
        manifest=ET.fromstring(package.read('manifest.xml'))
        node=manifest.find("Image[@name='layer_2']")
        assert node.get('w')=='38*#scene_scale' and node.get('h')=='26*#scene_scale'
        assert {source.get('src') for source in node.findall('SourcesAnimation/Source')}==set(dynamic['sequence']['frames'])
        assert set(dynamic['sequence']['frames'])<=set(package.namelist())
    assert Image.open(Path(result['folder'])/'画面预览.jpg').size==(320,240)


@pytest.mark.parametrize('size,limit',[((40,30),20_000),((160,120),30_000)])
def test_baked_animation_reduces_frames_then_size_within_budget(scene_request,tmp_path,monkeypatch,size,limit):
    scene_request['baked']={'1':baked_frames(tmp_path,'静态',static=True),
                            '2':baked_frames(tmp_path,'动态',size=size)}
    monkeypatch.setattr(motion,'ANIMATION_PIXEL_LIMIT',limit)
    root,payload=bridge.prepare_graphics(scene_request)
    sequence=payload['layers'][1]['sequence']
    assert 12<=len(sequence['frames'])<20 and sequence['period']==2000
    pixels=0
    for path in sequence['frames']:
        with Image.open(root/path) as image:
            pixels+=image.width*image.height
            if min(size)>=32:assert min(image.size)>=32 and image.width<size[0] and image.height<size[1]
    assert pixels<=int(limit*.88)


def test_baked_layers_share_remaining_animation_budget(scene_request,tmp_path,monkeypatch):
    scene_request['baked']={'1':baked_frames(tmp_path,'动态一'),'2':baked_frames(tmp_path,'动态二')}
    monkeypatch.setattr(motion,'ANIMATION_PIXEL_LIMIT',40_000)
    root,payload=bridge.prepare_graphics(scene_request)
    pixels=0
    for layer in payload['layers']:
        assert 12<=len(layer['sequence']['frames'])<20 and layer['sequence']['period']==2000
        for path in layer['sequence']['frames']:
            with Image.open(root/path) as image:pixels+=image.width*image.height
    assert pixels<=40_000


def test_fast_baking_only_reads_first_frame_and_applies_global_grade(scene_request,tmp_path,monkeypatch):
    scene=edit_scene(scene_request)
    scene['objects'][2]['effects'][0]['passes']=[{'constantshadervalues':{'brightness':.25}}]
    save_scene(scene_request,scene)
    scene_request['baked']={'2':baked_frames(tmp_path,'动态')}
    def unexpected_scan(record):
        pytest.fail('快速预览不应扫描后续帧')
    monkeypatch.setattr(motion,'baked_is_static',unexpected_scan)
    root,payload=bridge.prepare_graphics(scene_request,fast=True)
    layer=next(item for item in payload['layers'] if item['id']==2)
    assert 'sequence' not in layer
    with Image.open(root/layer['asset']) as image:
        assert image.convert('RGBA').getpixel((1,1))==(100,150,200,128)
        assert image.convert('RGBA').getpixel((1,29))[3]==0


@pytest.mark.parametrize('difference,static',[(8,True),(9,False)])
@pytest.mark.parametrize('channel',[0,3])
def test_static_detection_compares_every_frame_with_channel_threshold(scene_request,tmp_path,difference,static,channel):
    record=baked_frames(tmp_path,'微小变化')
    first=Image.new('RGBA',(40,30),(80,120,160,128))
    color=[80,120,160,128];color[channel]+=difference
    last=Image.new('RGBA',(40,30),tuple(color))
    (Path(record['dir'])/'frames.rgba.gz').write_bytes(gzip.compress(first.tobytes()*19+last.tobytes()))
    scene_request['baked']={'1':record,'2':baked_frames(tmp_path,'静态',static=True)}
    root,payload=bridge.prepare_graphics(scene_request)
    layer=payload['layers'][0]
    assert ('sequence' not in layer)==static
    assert len(list((root/'assets').iterdir()))==(2 if static else 21)


@pytest.mark.parametrize('size,changed,static',[((40,30),16,True),((40,30),17,False),
                                              ((332,332),55,True),((332,332),56,False)])
def test_static_detection_counts_changed_pixels_above_area_threshold(tmp_path,size,changed,static):
    record=baked_frames(tmp_path,'像素边界',size=size,count=2)
    first=Image.new('RGBA',size,(80,120,160,128));last=first.copy()
    for index in range(changed):last.putpixel((index%size[0],index//size[0]),(89,129,169,137))
    with gzip.open(Path(record['dir'])/'frames.rgba.gz','wb') as stream:
        stream.write(first.tobytes()+last.tobytes())
    assert motion.baked_is_static(record) is static


def test_small_moving_square_in_large_frames_remains_animated(scene_request,tmp_path):
    record=baked_frames(tmp_path,'小范围动画',size=(332,332))
    with gzip.open(Path(record['dir'])/'frames.rgba.gz','wb') as stream:
        for index in range(record['count']):
            image=Image.new('RGBA',(332,332))
            x=10+index*5
            ImageDraw.Draw(image).rectangle((x,100,x+7,107),fill=(80,120,160,128))
            stream.write(image.tobytes())
    scene_request['baked']={'1':record,'2':baked_frames(tmp_path,'静态',static=True)}
    _,payload=bridge.prepare_graphics(scene_request)
    assert len(payload['layers'][0]['sequence']['frames'])==20
    assert payload['layers'][0]['sequence']['period']==2000


def test_baked_cache_key_tracks_metadata_and_raw_file_changes(scene_request,tmp_path):
    baked={'2':baked_frames(tmp_path,'动态')}
    theme,draft=scene_request['theme'],scene_request['draft']
    original=bridge.graphic_key(theme,draft,baked)
    assert original!=bridge.graphic_key(theme,draft)
    for field,value in [('dir',str(tmp_path/'新目录')),('count',19),('width',39),('height',29),('fps',20.),('bbox',[0,0,20,20])]:
        changed=deepcopy(baked);changed['2'][field]=value
        if field=='dir':
            folder=Path(value);folder.mkdir()
            original_file=Path(baked['2']['dir'])/'frames.rgba.gz';stat=original_file.stat()
            (folder/'frames.rgba.gz').write_bytes(original_file.read_bytes())
            os.utime(folder/'frames.rgba.gz',ns=(stat.st_atime_ns,stat.st_mtime_ns))
        assert bridge.graphic_key(theme,draft,changed)!=original
    path=Path(baked['2']['dir'])/'frames.rgba.gz';stat=path.stat()
    path.write_bytes(path.read_bytes()+b'\0')
    os.utime(path,ns=(stat.st_atime_ns,stat.st_mtime_ns))
    assert bridge.graphic_key(theme,draft,baked)!=original
    path.write_bytes(path.read_bytes()[:-1])
    os.utime(path,ns=(stat.st_atime_ns,stat.st_mtime_ns+1_000_000))
    assert bridge.graphic_key(theme,draft,baked)!=original
