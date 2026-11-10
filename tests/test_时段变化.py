"""用散装场景验证时段变体、时间权重和视频播放条件。"""
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

import pytest
from PIL import Image,ImageFont

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'core'))
import 应用桥接 as bridge
import 场景动效 as motion
import 背屏转换 as converter
from test_逐层烘焙 import baked_frames


SWITCH=[[0,0],[360,0],[360.01,1],[1440,1]]
FADE=[[0,1],[360,1],[720,0],[1080,0],[1440,1]]


def inverse(points):
    return [[minute,1-value] for minute,value in points]


def write_json(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')


@pytest.fixture
def time_request(tmp_path):
    source=tmp_path/'主题'
    write_json(source/'project.json',{'title':'时段样例','type':'scene','file':'scene.json'})
    write_json(source/'models/picture.json',{'material':'materials/picture.json'})
    write_json(source/'materials/picture.json',{'passes':[{'shader':'genericimage4','textures':['picture.png']}]})
    Image.new('RGBA',(16,12),'#345678').save(source/'materials/picture.png')
    (source/'fonts').mkdir()
    (source/'fonts/sample.ttf').write_bytes(Path(ImageFont.truetype('DejaVuSans.ttf',12).path).read_bytes())
    first={'general':{'orthogonalprojection':{'width':64,'height':48}},'objects':[
        {'id':1,'name':'A','image':'models/picture.json','visible':False,'origin':'12 14 0','size':'16 12'},
        {'id':2,'name':'B','text':'Dawn','font':'fonts/sample.ttf','fontsize':12,'origin':'32 24 0','size':'64 24'},
        {'id':3,'name':'C','image':'models/picture.json','origin':'56 6 0','size':'8 6'}]}
    second=deepcopy(first)
    second['objects'][0]['visible']=True
    second['objects'][1]['text']='Night'
    write_json(source/'scene.json',first)
    current=deepcopy(second);current['objects'][1]['text']='Current'
    scratch=tmp_path/'工作';scratch.mkdir()
    return {'operation':'export','theme':{'type':'scene','title':'时段样例','source':str(source/'scene.json'),
                                        'resolvedScene':current,'engineRoots':[]},
            'draft':{'layout':{'scale':1,'x':.5,'y':.5,'clock':{'enabled':False,'rows':{}}},
                     'motion':{'fps':30},'properties':{},'layers':{}},
            'device':{'name':'测试背屏','width':320,'height':240},'cacheRoot':str(tmp_path/'缓存'),
            'scratchRoot':str(scratch),'outputDirectory':str(tmp_path/'成品'),
            'timeVariants':{'scenes':[first,second],'objects':{
                '1':[{'scene':0,'alpha':inverse(SWITCH),'baked':None},{'scene':1,'alpha':deepcopy(SWITCH),'baked':None}],
                '2':[{'scene':0,'alpha':deepcopy(FADE),'baked':None},{'scene':1,'alpha':inverse(FADE),'baked':None}]}}}


def interpolate(points,minute):
    left=next(index for index in range(len(points)-1) if minute<=points[index+1][0])
    start,value=points[left];end,next_value=points[left+1]
    return value+(next_value-value)*(minute-start)/(end-start)


def evaluate(expression,minute):
    expression=expression.replace('#hour24',str(int(minute//60))).replace('#minute',repr(minute%60))
    return eval(expression,{'__builtins__':{}},{'max':max,'min':min,'gt':lambda a,b:int(a>b),'eq':lambda a,b:int(a==b)})


def image_layer(identifier=1,**extra):
    return {'id':identifier,'asset':'assets/picture.png','x':32,'y':24,'w':64,'h':48,'rotation':0,'motion':1,**extra}


def test_export_replaces_objects_in_order_and_reports_variants(time_request):
    original=deepcopy(time_request)
    result=bridge.export(time_request)
    assert time_request==original
    with zipfile.ZipFile(result['path']) as package:
        root=ET.fromstring(package.read('manifest.xml'))
        groups=root.findall('Group')
        assert [group.find('Image').get('name') for group in groups]==['layer_1_t1','layer_2_t0','layer_2_t1']
        assert all('#hour24' in group.get('alpha') and '#minute' in group.get('alpha') for group in groups)
        assert root.find("Image[@name='layer_3']") is not None
        assert [node.get('name') for node in root if node.tag in {'Group','Image'}]==['time_1_t1','time_2_t0','time_2_t1','layer_3']
        assert len(root.findall('.//Image'))==4
        assets=[node.get('src') for node in root.findall('.//Image')]
        assert len(set(assets))==4 and all(path in package.namelist() for path in assets)
        assert package.read(assets[1])!=package.read(assets[2])
    report=json.loads((Path(result['folder'])/'转换报告.json').read_text(encoding='utf-8'))
    assert report['效果详情']['时段变化']=={'对象数':2,'变体数':4}
    assert '随时段变化' in report['恢复效果']
    assert root.get('useVariableUpdater')=='DateTime.Minute'


@pytest.mark.parametrize('points',[SWITCH,inverse(SWITCH),FADE,inverse(FADE),[[0,.2],[1440,.8]]])
def test_time_expression_matches_linear_interpolation(points):
    root=ET.fromstring(converter.make_manifest(64,48,[image_layer(time=points)],converter.DEFAULTS))
    expression=root.find('Group').get('alpha')
    for minute in [0,.01,359.99,360,360.0025,360.005,360.0099,360.01,361,500,719.9,720,900,1080,1200,1439,1440]:
        expected=255*interpolate(points,minute)
        assert evaluate(expression,minute)==pytest.approx(expected,abs=.01*255)


def test_fast_preview_ignores_variants_after_motion_cache(time_request):
    full=bridge.prepare(time_request)
    assert [layer['id'] for layer in full['layers']]==['1_t1','2_t0','2_t1',3]
    fast=bridge.prepare(time_request,fast=True)
    assert [layer['id'] for layer in fast['layers']]==[1,2,3]
    assert all('time' not in layer for layer in fast['layers'])
    assert full['assetRoot']!=fast['assetRoot']
    without_variants=deepcopy(time_request);without_variants.pop('timeVariants')
    assert bridge.prepare(without_variants,fast=True)==fast


def test_preview_payload_and_scene_cache_keep_independent_time_points(time_request):
    payload=bridge.prepare(time_request)
    assert [layer.get('time') for layer in payload['layers']]==[SWITCH,FADE,inverse(FADE),None]
    saved=json.loads((Path(payload['assetRoot'])/'场景.json').read_text(encoding='utf-8'))
    assert saved['layers']==payload['layers']
    payload['layers'][0]['time'][0][1]=.25
    assert time_request['timeVariants']['objects']['1'][1]['alpha']==SWITCH
    assert saved['layers'][0]['time']==SWITCH


def test_variant_world_transforms_include_parent_and_decode_only_output_objects(time_request,monkeypatch):
    for index,scene in enumerate(time_request['timeVariants']['scenes']):
        scene['objects'].append({'id':9,'origin':'20 30 0' if index else '5 7 0','scale':'3 3 1','alpha':.5})
        scene['objects'][0].update(parent=9,origin='2 3 0')
    time_request['theme']['resolvedScene']['objects'].append({'id':9,'origin':'1 1 0','scale':'1 1 1'})
    time_request['theme']['resolvedScene']['objects'][0]['parent']=9
    native=[];original=converter.scene_layers
    def native_layers(source,config,data,*args):
        native.append([obj['id'] for obj in data[2]['objects']])
        return original(source,config,data,*args)
    monkeypatch.setattr(converter,'scene_layers',native_layers)
    payload=bridge.prepare(time_request)
    layer=payload['layers'][0]
    assert {key:layer[key] for key in ('id','x','y','w','h','opacity')}=={
        'id':'1_t1','x':26,'y':9,'w':48,'h':36,'opacity':.5}
    assert native==[['1_t1',3]]


def test_each_variant_uses_its_baked_frames_and_shared_budget(time_request,tmp_path,monkeypatch):
    variants=time_request['timeVariants']
    for scene in variants['scenes']:
        scene['objects'][0].update(visible=True,image='models/baked-only.json')
    first=baked_frames(tmp_path,'状态一',bbox=(1,2,20,18))
    second=baked_frames(tmp_path,'状态二',bbox=(10,15,30,20));second['fps']=5
    variants['objects']['1'][0]['baked']=first
    variants['objects']['1'][1]['baked']=second
    time_request['baked']={'3':baked_frames(tmp_path,'不变对象',bbox=(0,0,64,48))}
    monkeypatch.setattr(motion,'ANIMATION_PIXEL_LIMIT',50_000)
    root,payload=bridge.prepare_graphics(time_request)
    layers={layer['id']:layer for layer in payload['layers']}
    assert [layers['1_t0'][key] for key in ('x','y','w','h')]==[11,11,20,18]
    assert [layers['1_t1'][key] for key in ('x','y','w','h')]==[25,25,30,20]
    assert layers['1_t0']['time']==inverse(SWITCH) and layers['1_t1']['time']==SWITCH
    assert layers['1_t0']['sequence']['period']==2000 and layers['1_t1']['sequence']['period']==4000
    assert 'time' not in layers[3]
    pixels=0;paths=[]
    for identifier in ('1_t0','1_t1',3):
        frames=layers[identifier]['sequence']['frames']
        assert len(frames)>=12
        for path in frames:
            with Image.open(root/path) as image:pixels+=image.width*image.height
        paths.extend(frames)
    assert len(paths)==len(set(paths)) and pixels<=50_000
    assert '_t0' in layers['1_t0']['asset'] and '_t1' in layers['1_t1']['asset']
    assert '逐层完整渲染' in payload['restored']


def test_cache_key_tracks_scenes_weights_and_variant_baking(time_request,tmp_path):
    theme,draft=time_request['theme'],time_request['draft']
    variants=time_request['timeVariants']
    original=bridge.graphic_key(theme,draft,None,variants)
    assert original!=bridge.graphic_key(theme,draft)
    for change in ('scene','alpha','selection','order'):
        changed=deepcopy(variants)
        if change=='scene':changed['scenes'][1]['objects'][1]['text']='Evening'
        elif change=='alpha':changed['objects']['1'][1]['alpha'][1][0]=350
        elif change=='selection':changed['objects']['2'][1]['scene']=0
        else:changed['objects']['2'].reverse()
        assert bridge.graphic_key(theme,draft,None,changed)!=original
    variants['objects']['1'][1]['baked']=baked_frames(tmp_path,'缓存状态')
    baked_key=bridge.graphic_key(theme,draft,None,variants)
    assert baked_key!=original
    file=Path(variants['objects']['1'][1]['baked']['dir'])/'frames.rgba.gz'
    file.write_bytes(file.read_bytes()+b'\0')
    assert bridge.graphic_key(theme,draft,None,variants)!=baked_key


@pytest.mark.parametrize('seconds',[False,True])
def test_video_variants_have_visibility_triggers_and_conditional_resume(seconds):
    layers=[image_layer('day',video='assets/day.mp4',time=SWITCH),
            image_layer('night',video='assets/night.mp4',time=inverse(SWITCH)),
            image_layer('steady',video='assets/steady.mp4')]
    config={**converter.DEFAULTS,'显示秒':seconds}
    root=ET.fromstring(converter.make_manifest(64,48,layers,config))
    assert root.get('useVariableUpdater')==('DateTime.Second' if seconds else 'DateTime.Minute')
    for identifier,points in [('day',SWITCH),('night',inverse(SWITCH))]:
        target='video_'+identifier
        video=root.find(f"Video[@name='{target}']")
        expression=video.get('visibility')
        assert expression.startswith('gt(') and '#hour24' in expression and '#minute' in expression
        for minute in (0,360,360.005,360.01,600,1439):
            assert evaluate(expression,minute)==int(interpolate(points,minute)>.5)
        variable=root.find(f"Var[@name='{target}_visible']")
        assert variable.get('expression')==expression and variable.get('threshold')=='0'
        trigger=variable.find('Trigger')
        play=trigger.find("VideoCommand[@command='play']")
        pause=trigger.find("VideoCommand[@command='pause']")
        assert play.get('target')==pause.get('target')==target
        assert play.get('condition')==f'#{target}_visible'
        assert pause.get('condition')==f'eq(#{target}_visible,0)'
        resume=root.find(f"ExternalCommands/Trigger[@action='resume']/VideoCommand[@target='{target}'][@command='play']")
        assert resume.get('condition')==expression
    assert root.find("Video[@name='video_steady']").get('visibility') is None
    assert root.find("ExternalCommands/Trigger[@action='resume']/VideoCommand[@target='video_steady'][@command='play']").get('condition') is None
    pauses=root.findall("ExternalCommands/Trigger[@action='pause']/VideoCommand")
    assert {node.get('target') for node in pauses}=={'video_day','video_night','video_steady'}
    assert all(node.get('command')=='pause' and node.get('condition') is None for node in pauses)


def test_time_group_preserves_image_attributes_and_animation():
    layer=image_layer(sequence={'frames':['assets/one.png','assets/two.png'],'period':1000},
                      travel=[[0,1,2],[1000,3,4]],fade=[[0,0],[500,255],[1000,0]])
    plain=ET.fromstring(converter.make_manifest(64,48,[layer],converter.DEFAULTS)).find('Image')
    timed=ET.fromstring(converter.make_manifest(64,48,[{**layer,'time':SWITCH}],converter.DEFAULTS)).find('Group/Image')
    assert [(node.tag,node.attrib) for node in timed.iter()]==[(node.tag,node.attrib) for node in plain.iter()]


@pytest.mark.parametrize('minute',[0,720,1439])
def test_still_preview_uses_local_time_and_preserves_source_alpha(monkeypatch,minute):
    class LocalTime:
        @staticmethod
        def now():return datetime(2026,11,9,minute//60,minute%60)
    monkeypatch.setattr(converter,'datetime',LocalTime)
    background=Image.new('RGBA',(64,48),'blue')
    foreground=Image.new('RGBA',(64,48),(255,0,0,128))
    layers=[image_layer(1,image=background),image_layer(2,image=foreground,time=[[0,0],[1440,1]]),
            image_layer(3,image=Image.new('RGBA',(64,48),'green'),time=[[0,0],[1440,0]])]
    config={**converter.DEFAULTS,'预览宽度':64,'预览高度':48,'感应幅度':0,'画面缩放':1}
    result=converter.still_preview(64,48,layers,config)
    expected=Image.alpha_composite(background,Image.new('RGBA',(64,48),(255,0,0,round(128*minute/1440))))
    assert result.getpixel((32,24))==expected.convert('RGB').getpixel((32,24))
    assert foreground.getpixel((32,24))==(255,0,0,128)
