"""验证真实主题设置、时钟和不同机型产物之间的一致性。"""
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile
from copy import deepcopy
from hashlib import sha256
import importlib.util

import pytest
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'core'))
import 应用桥接 as bridge
import 背屏转换 as converter
import 背屏时钟 as clockwork

THEME=Path(os.environ.get('YINGCHUANG_TEST_THEME',str(Path.home()/'.local/share/Steam/steamapps/workshop/content/431960/3352465485')))


@pytest.fixture
def job_config(tmp_path):
    if not (THEME/'scene.pkg').is_file():pytest.skip('本机没有猫猫样例')
    wallpaper=json.loads((THEME/'project.json').read_text())
    widgets=[{'key':key,**{name:spec[name] for name in ('x','y','size','align')}}
             for key,spec in clockwork.WIDGETS.items() if spec.get('core')]
    next(item for item in widgets if item['key']=='time').update(hourFormat='24',seconds=False)
    project={'version':2,'framing':{'scale':1.06,'x':.5,'y':.5,'flip':False},'showWidgets':True,'widgets':widgets,
             'motion':{'amount':.02,'sensitivity':4,'smoothing':.16,'vertical':.3,'fps':30},
             'properties':{k:v.get('value') for k,v in wallpaper['general']['properties'].items() if 'value'in v},'layers':{},
             'export':{'mode':'layers','quality':'standard'}}
    job=tmp_path/'jobs';job.mkdir()
    return {'theme':{'id':'cat','title':'猫猫','source':str(THEME/'scene.pkg'),'type':'scene','engineRoots':[str(THEME.parents[3]/'common/wallpaper_engine/assets')]},
            'project':project,'device':{'name':'小米 17 Pro','width':904,'height':572},'cacheRoot':str(tmp_path/'cache'),'scratchRoot':str(job)}


def test_author_switch_and_combo_change_actual_scene(job_config):
    original=sha256((THEME/'scene.pkg').read_bytes()).hexdigest()
    job_config['project']['properties']['birds']=False
    job_config['project']['properties']['wall']='1'
    pkg,_,scene,w,h,props=bridge.loaded_scene(job_config['theme'],job_config['project'])
    worlds=converter.world_transforms(scene['objects'],props,w,h,[])
    assert worlds[74971] is None and worlds[80868] is None
    assert worlds[62] is not None and worlds[66] is None
    assert sha256((THEME/'scene.pkg').read_bytes()).hexdigest()==original


def test_clock_keeps_active_original_font(job_config):
    selected=bridge.selected_clock_fonts(job_config['theme'],job_config['project'])
    assert all(item[1]['字体文件']=='fonts/Garet-Book.otf' for item in selected.values())
    assert all(bridge.font_name(item[0],'')=='Garet Book' for item in selected.values())
    job_config['project']['properties']['daydatetime']=False
    selected=bridge.selected_clock_fonts(job_config['theme'],job_config['project'])
    assert all(item[1]['字体文件']=='fonts/Garet-Book.otf' for item in selected.values())


def test_null_particle_sequence_uses_source_default(job_config,tmp_path):
    from 场景动效 import SceneAssets,sprite_tracks
    pkg,_,scene,w,h,props=bridge.loaded_scene(job_config['theme'],job_config['project'])
    worlds=converter.world_transforms(scene['objects'],props,w,h,[])
    obj=next(item for item in scene['objects'] if item.get('name')=='Brouillard 1')
    (tmp_path/'assets').mkdir();assets=SceneAssets(pkg,tmp_path,converter.decode_tex)
    assert assets.json(obj['particle'])['sequencemultiplier'] is None
    layers=sprite_tracks(assets,obj,worlds[obj['id']],w,h,'fog',3,props)
    assert len(layers)>0
    assert any(layer.get('sequence',{}).get('frames') for layer in layers)


def test_clock_layout_color_and_twelve_hour_export(job_config,tmp_path):
    project=job_config['project']
    next(item for item in project['widgets'] if item['key']=='time').update(x=.8,y=.72,size=76,align='right',hourFormat='12',color='#d45b92')
    config=bridge.config_for(project,job_config['device']);selected=bridge.selected_clock_fonts(job_config['theme'],project)
    (tmp_path/'assets').mkdir();clock=clockwork.build_clock(tmp_path,config,selected)
    layer={'id':1,'asset':'assets/bg.png','x':50,'y':50,'w':100,'h':100,'rotation':0,'motion':1}
    tree=ET.fromstring(converter.make_manifest(100,100,[layer],config,clock))
    group=tree.find("Group[@name='clock_time']")
    assert group.get('x').startswith('#view_width*0.8-') and group.get('y')=='#view_height*0.72'
    assert '#hour24%12' in ET.tostring(group,encoding='unicode')
    image=Image.open(tmp_path/'assets/clock_time_num_8.png').convert('RGBA')
    colors={p[:3] for p in image.getdata() if p[3]>240};assert colors=={(212,91,146)}
    assert clock['fonts']['时间']['字号']==76


@pytest.mark.parametrize('width,height',[(904,572),(976,596),(912,596)])
def test_device_sizes_are_written_to_preview_and_manifest(job_config,tmp_path,width,height):
    # 使用已解码的图层验证成品尺寸，不重复渲染整套动画。
    job_config['device'].update(width=width,height=height)
    config=bridge.config_for(job_config['project'],job_config['device'])
    stage=tmp_path/f'{width}-{height}';(stage/'assets').mkdir(parents=True)
    image=Image.new('RGBA',(320,200),'#123456');image.save(stage/'assets/bg.png')
    layers=[{'id':1,'asset':'assets/bg.png','x':160,'y':100,'w':320,'h':200,'rotation':0,'motion':1,'image':image}]
    package,_=converter.write_product(stage,320,200,layers,config,'尺寸检查',[],[],{},'image')
    assert Image.open(stage/'画面预览.jpg').size==(width,height)
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None
        tree=ET.fromstring(archive.read('manifest.xml'));assert tree.get('screenWidth')==str(width)


def test_video_manifest_contains_lifecycle_and_asset(job_config):
    c=bridge.config_for(job_config['project'],job_config['device']);c['视频音量']=.3
    layer={'id':'video','video':'assets/wallpaper.mp4','asset':'assets/poster.jpg','x':160,'y':100,'w':320,'h':200,'rotation':0,'motion':1}
    root=ET.fromstring(converter.make_manifest(320,200,[layer],c))
    assert root.find('Video') is not None and root.get('transparentSurface')=='true'
    assert root.find("ExternalCommands/Trigger[@action='init']/VideoCommand").get('path')=="'assets/wallpaper.mp4'"
    assert root.find("ExternalCommands/Trigger[@action='resume']/VideoCommand[@command='setVolume']").get('volume')=='0.3'
    assert root.find("ExternalCommands/Trigger[@action='pause']/VideoCommand").get('command')=='pause'


def test_theme_clock_none_is_respected_in_back_screen(job_config):
    job_config['project']['properties']['clock']='2'
    config=bridge.config_for(job_config['project'],job_config['device'])
    _,clock=bridge.prepare_clock(job_config,config)
    time=next(row for row in clock['rows'] if row['key']=='time')
    assert time['sourceVisible'] is False and time['visible'] is False
    assert next(row for row in clock['rows'] if row['key']=='week')['visible'] is True


def test_manual_layer_font_is_read_without_changing_original(job_config,tmp_path):
    package,_,original,_,_,_=converter.read_scene(THEME/'scene.pkg')
    font_data=package.read('fonts/workshop/3219510589/LEMONMILK-Bold.otf')
    chosen=tmp_path/'选择的字体.otf';chosen.write_bytes(font_data)
    job_config['project']['layers']={'154405':{'font':str(chosen),'fontsize':51}}
    view,_,scene,_,_,_=bridge.loaded_scene(job_config['theme'],job_config['project'])
    edited=next(o for o in scene['objects'] if o['id']==154405)
    assert view.read(edited['font'])==font_data
    assert edited['fontsize']==51
    assert next(o for o in original['objects'] if o['id']==154405)['font']=='fonts/Garet-Book.otf'
