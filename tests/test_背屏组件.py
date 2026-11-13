"""验证字体替换、组件动态排版以及完整产物中的共用预览。"""
from datetime import datetime
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

from fontTools import subset
from fontTools.ttLib import TTFont
from PIL import Image, ImageFont
import pytest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'core'))
import 应用桥接 as bridge
import 背屏时钟 as clockwork
import 背屏转换 as converter


def font_data():
    return Path(ImageFont.truetype('DejaVuSans.ttf',12).path).read_bytes()


def draft_for(*visible):
    return {'layout':{'scale':1,'x':.5,'y':.5,'clock':{'enabled':True,'language':'en','rows':{
        key:{'visible':True} for key in visible}}},'appearance':{'fonts':{},'colors':{'time':'#42b5a6'}}}


def test_font_without_digits_keeps_time_with_fallback(tmp_path):
    with TTFont(BytesIO(font_data())) as font:
        reduced=subset.Subsetter();reduced.populate(text='ABCDEFGHIJKLMNOPQRSTUVWXYZ: .');reduced.subset(font)
        stream=BytesIO();font.save(stream)
    data=stream.getvalue()
    assert '0' in clockwork.missing_glyphs(clockwork.font_coverage(data)[1],'0123456789')
    (tmp_path/'assets').mkdir()
    selected={role:(data,{'字体文件':'无数字.ttf'}) for role in clockwork.ROLES}
    clock=clockwork.build_clock(tmp_path,converter.DEFAULTS,selected)
    assert any(row['key']=='time' for row in clock['rows'])
    assert clock['fonts']['时间']['SHA-256']!=sha256(data).hexdigest()
    assert any(item['key']=='time' and '缺少' in item['message'] and '已临时改用' in item['message'] for item in clock['warnings'])
    assert (tmp_path/'assets/clock_time_num_8.png').is_file()


def test_missing_theme_and_explicit_widget_font_are_warnings(tmp_path):
    scene={'general':{'orthogonalprojection':{'width':100,'height':60}},'objects':[
        {'id':1,'name':'clock','text':'10:08','font':'fonts/缺失.ttf','origin':'50 30 0'}]}
    (tmp_path/'scene.json').write_text(json.dumps(scene),encoding='utf-8')
    (tmp_path/'project.json').write_text(json.dumps({'type':'scene','file':'scene.json'}),encoding='utf-8')
    theme={'type':'scene','source':str(tmp_path/'scene.json')}
    detail=bridge.inspect_theme({'theme':theme,'draft':{}})
    assert detail['hasClock'] is True and '未随主题提供' in detail['fontIssue']
    assert detail['sourceFonts']=={} and detail['sourceColors']=={}
    draft=draft_for('lunar','steps','weather')
    config=bridge.config_for(draft,{'width':976,'height':596,'name':'测试机型'})
    (tmp_path/'assets').mkdir()
    clock=clockwork.build_clock(tmp_path,config,bridge.selected_clock_fonts(theme,draft))
    assert [item['key'] for item in clock['warnings']]==['week','date','time']
    assert {'lunar','steps','weather'}<={row['key'] for row in clock['rows']}
    draft['appearance']['fonts']['steps']=str(tmp_path/'不存在.ttf')
    selected=bridge.selected_clock_fonts(theme,draft)
    assert selected['时间'][0] is None and selected['steps'][0] is None
    assert selected['steps'][1]['提醒']
    clock=clockwork.build_clock(tmp_path,config,selected)
    assert any(item['key']=='steps' and '无法读取步数字体' in item['message'] for item in clock['warnings'])
    data=font_data();chosen=tmp_path/'选中的字体.ttf';chosen.write_bytes(data)
    draft['appearance']['fonts']['steps']=str(chosen)
    assert bridge.selected_clock_fonts(theme,draft)['steps'][0]==data


def test_fallback_prefers_regular_weight():
    candidates=clockwork.fallback_candidates()
    noto=[path for path in candidates if path.stem.startswith('NotoSansCJK-')]
    if len(noto)>1 and any('Regular' in path.stem for path in noto):
        assert 'Regular' in noto[0].stem


@pytest.fixture(scope='module')
def widgets(tmp_path_factory):
    stage=tmp_path_factory.mktemp('背屏组件');(stage/'assets').mkdir()
    draft=draft_for('lunar','steps','distance','temperature','weather','range','air','sunrise','sunset','battery','text')
    for key,align in (('steps','left'),('distance','right'),('temperature','center')):
        draft['layout']['clock']['rows'][key]['align']=align
    draft['layout']['clock']['rows']['text']['text']='今天也要开心'
    config=bridge.config_for(draft,{'width':976,'height':596,'name':'测试机型','safeLeft':.32,
                                  'camera':{'x':152,'ys':[151,451],'r':102},'cornerRadius':84})
    selected={role:(font_data(),{'字体文件':'本机字体'}) for role in clockwork.ROLES}
    clock=clockwork.build_clock(stage,config,selected)
    config['组件示例']={**{key:field['sample'] for key,field in clockwork.FIELDS.items() if 'sample' in field},
                        'steps':10002,'dist':9.995,'temp':-8,'lm':12,'ld':29}
    image=Image.new('RGBA',(32,20),'#123456');image.save(stage/'assets/bg.png')
    layers=[{'id':1,'asset':'assets/bg.png','x':488,'y':298,'w':976,'h':596,'motion':1,'rotation':0,'image':image}]
    package,report=converter.write_product(stage,976,596,layers,config,'组件检查',[],[],{},'image',clock)
    return stage,config,clock,package,report


def test_widget_assets_binders_and_complete_product(widgets):
    stage,config,clock,package,report=widgets
    rows={row['key']:row for row in clock['rows']}
    assert 'calories' not in rows and rows['steps']['size']==24
    assert set(config['时钟排版'])==set(clockwork.WIDGETS)
    assert all(item['message'] in report['未迁移及注意事项'] for item in clock['warnings'])
    with zipfile.ZipFile(package) as archive:
        root=ET.fromstring(archive.read('manifest.xml'))
        assert set(clock['assets'])<=set(archive.namelist()) and archive.testzip() is None
    for node in root.iter('Image'):
        src=node.get('src')
        if not src or src=='assets/bg.png':continue
        if node.get('srcid') is None:assert src in clock['assets']
        else:
            path=Path(src)
            assert any(re.fullmatch(re.escape(str(path.with_suffix('')))+r'_\d+'+re.escape(path.suffix),file) for file in clock['assets'])
    assert root.get('useVariableUpdater')=='Battery,DateTime.Minute'
    health=root.find("VariableBinders/ContentProviderBinder[@name='MiSteps']")
    assert health.get('uri')=='content://com.mi.health.provider.main/activity/steps/brief'
    assert health.get('columns')=='steps,goal,distance,energy,strength_duration,summary'
    assert health.get('countName')=='hasSteps'
    assert all(node.get('type')=='string' for node in health.findall('Variable'))
    weather=root.find("VariableBinders/ContentProviderBinder[@name='WeatherProvider']")
    assert weather.get('uri')=='content://weather/actualWeatherData/1' and weather.get('countName')=='hasweather'
    assert weather.find("Variable[@name='weather_temphigh']").get('type')=='string[]'
    commands={node.get('name'):node.get('expression') for node in weather.findall('Trigger/VariableCommand')}
    assert commands['yc_tmax']=='@weather_temphigh[0]' and commands['yc_tmin']=='@weather_templow[0]'
    assert commands['yc_rise_h']=="formatDate('H',#weather_sunrise)" and commands['yc_set_m']=="formatDate('m',#weather_sunset)"
    for action in ('init','resume'):
        assert {node.get('name') for node in root.findall(f"ExternalCommands/Trigger[@action='{action}']/BinderCommand")}=={'MiSteps','WeatherProvider'}
    watch=root.find("Var[@name='yc_minute_watch']")
    assert watch.get('expression')=='#minute' and watch.get('threshold')=='1'
    assert watch.find('Trigger/BinderCommand').get('name')=='MiSteps'
    assert all('<' not in value and '>' not in value for node in root.iter() for value in node.attrib.values())


@pytest.mark.parametrize('samples',[{'steps':0,'dist':0,'temp':-1,'wx':-1,'lm':0,'ld':0},
                                  {'steps':98765,'dist':9.995,'temp':-18,'wx':25,'lm':12,'ld':29},
                                  {'steps':999999,'dist':123.45,'temp':0,'wx':99,'lm':23,'ld':30}])
def test_python_and_shared_js_row_parts_match(widgets,samples):
    _,_,clock,_,_=widgets
    values=clockwork.field_values(datetime(2026,11,13,13,8,42),samples)
    script="const w=require('./core/组件绘制.cjs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify(p.rows.map(r=>w.rowParts(r,p.values))))});"
    result=subprocess.run(['node','-e',script],cwd=ROOT,input=json.dumps({'rows':clock['rows'],'values':values}),text=True,capture_output=True,check=True)
    for row,js in zip(clock['rows'],json.loads(result.stdout)):
        width,parts=clockwork.row_parts(row,values)
        assert js=={'w':width,'parts':[{'file':file,'x':x,'w':w} for file,x,w in parts]}


def evaluate(expression,variables):
    def choose(*items):
        return next((items[i+1] for i in range(0,len(items)-1,2) if items[i]),items[-1])
    functions={'int':int,'min':min,'max':max,'abs':abs,'num':float,'ifelse':choose,
               'gt':lambda a,b:int(a>b),'ge':lambda a,b:int(a>=b),'lt':lambda a,b:int(a<b),
               'le':lambda a,b:int(a<=b),'eq':lambda a,b:int(a==b)}
    text=re.sub(r'[#@](\w+)',lambda match:repr(variables[match[1]]),expression)
    return eval(text,{'__builtins__':{}},functions)


@pytest.mark.parametrize('steps,distance,temp,choice',[(0,0,-1,0),(9,9.995,0,26),(10002,123.45,-19,25),(999999,999.99,18,1)])
def test_manifest_dynamic_images_match_preview_layout(widgets,steps,distance,temp,choice):
    _,config,clock,package,_=widgets
    samples={'steps':steps,'dist':distance,'temp':temp,'wx':choice,**{k:config['组件示例'][k] for k in ('lm','ld')}}
    values=clockwork.field_values(datetime(2026,11,13,10,8),samples)
    variables={'MiSteps_steps':str(steps),'MiSteps_distance':str(distance),'weather_temperature':temp,'weather_id':choice,
               'month_lunar':0,'month_lunar_leap':1,'date_lunar':30,'view_width':976,'view_height':596,'clock_unit':1}
    with zipfile.ZipFile(package) as archive:root=ET.fromstring(archive.read('manifest.xml'))
    for row in clock['rows']:
        if row['key'] not in {'steps','distance','temperature','weather','lunar'}:continue
        group=root.find(f"Group[@name='clock_{row['key']}']")
        assert evaluate(group.get('x'),variables)==976*row['nx']
        actual=[]
        for node in group:
            if node.tag=='Var':variables[node.get('name')]=evaluate(node.get('expression'),variables)
            elif node.tag=='Image':
                if node.get('visibility') and not evaluate(node.get('visibility'),variables):continue
                file=node.get('src')
                if node.get('srcid') is not None:
                    path=Path(file);file=str(path.with_name(path.stem+'_'+str(int(evaluate(node.get('srcid'),variables)))+path.suffix))
                assert file in clock['assets']
                actual.append((file,evaluate(node.get('x'),variables),evaluate(node.get('w'),variables)))
        width,parts=clockwork.row_parts(row,values)
        shift=width/2 if row['align']=='left' else -width/2 if row['align']=='right' else 0
        assert actual==[(file,x+shift,w) for file,x,w in parts]


def test_export_preview_runs_shared_rows_and_real_camera(widgets):
    stage,config,clock,_,_=widgets
    html=(stage/'交互预览.html').read_text(encoding='utf-8')
    assert '__WIDGET_DRAW__' not in html and '__SCENE_DATA__' not in html
    script=re.search(r'<script>(.*?)</script>',html,re.S)[1]
    harness=r"""
const fs=require('fs'), vm=require('vm'), code=fs.readFileSync(0,'utf8'), elements={}, draws=[];
const context={drawImage:(image,x,y,w,h)=>draws.push([image.src,x+w/2,y+h/2,w,h])};
function element(){return {style:{},children:[],classList:{add(){}},appendChild(child){this.children.push(child)},replaceChildren(){this.children=[]},addEventListener(){},setAttribute(){},getContext(){return context}}}
const sandbox=vm.createContext({document:{getElementById(id){return elements[id]??=element()},createElement:element,documentElement:{dataset:{}}},Image:class{set src(v){this.file=v;this.onload()}get src(){return this.file}},requestAnimationFrame(){}});
vm.runInContext(code,sandbox);
setImmediate(()=>{vm.runInContext('drawClock(new Date(2026,10,13,10,8,12))',sandbox);console.log(JSON.stringify({draws,camera:elements.camera.children.map(x=>x.style),radius:elements.screen.style.borderRadius}))});
"""
    result=subprocess.run(['node','-e',harness],input=script,text=True,capture_output=True,check=True)
    result=json.loads(result.stdout)
    values=clockwork.field_values(datetime(2026,11,13,10,8,12),config['组件示例'])
    expected=[]
    for row in clock['rows']:
        width,parts=clockwork.row_parts(row,values)
        shift=width/2 if row['align']=='left' else -width/2 if row['align']=='right' else 0
        expected.extend((file,row['nx']*976+x+shift,row['ny']*596,w,row['h']) for file,x,w in parts)
    assert len(result['draws'])==len(expected)
    for actual,(file,*geometry) in zip(result['draws'],expected):
        assert actual[0]==file and actual[1:]==pytest.approx(geometry)
    assert len(result['camera'])==3
    assert result['camera'][0]['left']==str(152/976*100)+'%'
    assert result['camera'][1]['top']==str(451/596*100)+'%'
    assert result['camera'][2]['left']=='32%'
    assert result['radius']


def test_samples_do_not_change_glyph_cache_and_reach_preview(tmp_path):
    source=tmp_path/'原图.png';Image.new('RGB',(48,32),'#123456').save(source)
    (tmp_path/'scratch').mkdir()
    request={'theme':{'type':'image','source':str(source),'title':'示例'},'draft':draft_for('lunar','steps'),
             'device':{'width':976,'height':596,'name':'测试机型'},'cacheRoot':str(tmp_path/'cache'),
             'scratchRoot':str(tmp_path/'scratch'),'widgetSamples':{'lm':13,'ld':28}}
    first=bridge.prepare(request)
    assert first['clock']['warnings'] and first['config']['组件示例']['lm']==13
    assert first['config']['组件示例']['steps']==6542
    request['widgetSamples']={'lm':1,'ld':2}
    root,clock=bridge.prepare_clock(request,first['config'])
    assert str(root)==first['clockRoot'] and clock==first['clock']
    second=bridge.prepare(request)
    assert second['clockRoot']==first['clockRoot'] and second['config']['组件示例']['lm']==1
    canvas=Image.new('RGBA',(976,596));seen=[]
    original=clockwork.row_parts
    def record(row,values):
        seen.append(values)
        return original(row,values)
    from unittest.mock import patch
    with patch.object(clockwork,'row_parts',record):
        clockwork.draw_clock(canvas,root,clock,488,298,1,second['config']['组件示例'])
    assert seen and all(value['lm']==1 and value['ld']==2 for value in seen)
