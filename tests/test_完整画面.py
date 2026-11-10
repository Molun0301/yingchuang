"""完整画面录制结果进入背屏包，以及透视场景的时钟层识别。"""
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

import imageio_ffmpeg

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'core'))
import 应用桥接 as bridge


def draft(clock=False):
    rows={k:{'visible':True,'x':.7,'y':y,'size':40,'align':'center'} for k,y in (('week',.3),('date',.45),('time',.6))}
    return {'deviceId':'xiaomi-18-pro','layout':{'scale':1.8,'x':.2,'y':.9,'clock':{'enabled':clock,'language':'en','format':'24','seconds':False,'rows':rows}},
            'appearance':{'fonts':dict.fromkeys(('week','date','time'),''),'colors':dict.fromkeys(('week','date','time'),'')},
            'motion':{'amount':.02,'sensitivity':4,'smoothing':.16,'vertical':.3,'fps':30},'properties':{},'layers':{}}


def test_recording_becomes_full_frame_video_without_reframing(tmp_path):
    video=tmp_path/'record.mp4'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-loglevel','error','-f','lavfi','-i','testsrc=size=950x608:rate=30:duration=1',
                    '-pix_fmt','yuv420p','-c:v','libx264',str(video)],check=True)
    (tmp_path/'scratch').mkdir()
    request={'operation':'export','theme':{'id':'t','title':'录制样例','type':'web','source':str(tmp_path/'index.html')},'draft':draft(),
             'device':{'name':'小米 18 Pro','width':912,'height':596},'cacheRoot':str(tmp_path/'cache'),'scratchRoot':str(tmp_path/'scratch'),
             'outputDirectory':str(tmp_path/'out'),'recording':{'path':str(video),'width':950,'height':608,'fps':30,'duration':1,'fade':.2}}
    result=bridge.export(request)
    with zipfile.ZipFile(result['path']) as package:
        manifest=ET.fromstring(package.read('manifest.xml'))
        assert package.getinfo('assets/wallpaper.mp4').file_size==video.stat().st_size
    node=manifest.find('Video')
    assert node is not None and node.get('w')=='950*#scene_scale'
    # 录制时已经按排版取景，导出不再二次缩放或偏移，只保留整幅感应位移。
    scale=manifest.find("Var[@name='scene_scale']").get('expression')
    assert scale.endswith('*1') and '/950' in scale
    report=json.loads((Path(result['folder'])/'转换报告.json').read_text(encoding='utf-8'))
    assert report['效果详情']['渲染方式']=='完整画面录制' and report['配置']['横向取景']==.5


def test_perspective_scene_still_reports_clock_layers(tmp_path):
    scene={'general':{'cameraeye':'0 0 1'},'objects':[{'id':5,'name':'bg','image':'models/a.json'},{'id':9,'name':'label','text':'21:45'},{'id':11,'name':'title','text':'Hello'}]}
    (tmp_path/'scene.json').write_text(json.dumps(scene),encoding='utf-8')
    (tmp_path/'project.json').write_text(json.dumps({'type':'scene','file':'scene.json'}),encoding='utf-8')
    detail=bridge.inspect_theme({'theme':{'type':'scene','source':str(tmp_path/'scene.json')},'draft':{}})
    assert detail['renderable'] is False and detail['clockLayerIds']==[9]
