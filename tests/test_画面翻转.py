"""用独立像素与实际视频验证镜像发生在资源裁切之前。"""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

import imageio_ffmpeg
from PIL import Image
import pytest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'core'))
import 应用桥接 as bridge
import 背屏转换 as converter
import 画质压缩 as compression


def image_layer(**changes):
    return {'id':1,'asset':'assets/a.png','x':25,'y':30,'w':20,'h':12,'rotation':15,'motion':1,**changes}


def test_mirror_shared_images_geometry_travel_and_tilt_contents(tmp_path):
    (tmp_path/'assets').mkdir()
    frames=[f'assets/tilt_{i}.png' for i in range(3)]
    originals=[]
    for i,file in enumerate(frames):
        image=Image.new('RGBA',(4,2));image.putdata([(10*i+x,20+y,90,70+x) for y in range(2) for x in range(4)])
        image.save(tmp_path/file);originals.append(image)
    poster=Image.new('RGB',(32,16),'#e01010');poster.paste('#1020e0',(16,0,32,16));poster.save(tmp_path/'assets/poster.jpg',quality=100,subsampling=0)
    sequence={'frames':frames,'mode':'tilt','period':1000}
    layers=[image_layer(asset=frames[0],sequence=deepcopy(sequence),travel=[[0,3,-2],[100,7,6]]),
            image_layer(id=2,asset=frames[0],sequence=deepcopy(sequence),x=40),
            image_layer(id=3,asset='assets/poster.jpg',video='assets/test.mp4')]
    mirror=bridge.mirror_layers(tmp_path,layers,100)
    assert mirror=={'assets/test.mp4'}
    assert layers[0]['x']==75 and layers[0]['rotation']==-15
    assert layers[0]['y']==30 and layers[0]['travel']==[[0,-3,-2],[100,-7,6]]
    assert layers[0]['sequence']==sequence and layers[1]['x']==60
    for file,original in zip(frames,reversed(originals)):
        with Image.open(tmp_path/file) as image:
            assert image.format=='PNG'
            assert image.tobytes()==original.transpose(Image.Transpose.FLIP_LEFT_RIGHT).tobytes()
    with Image.open(tmp_path/'assets/poster.jpg') as image:
        assert image.format=='JPEG'
        assert image.getpixel((4,8))==pytest.approx((16,32,224),abs=3)
        assert image.getpixel((28,8))==pytest.approx((224,16,16),abs=3)
    root=ET.fromstring(converter.make_manifest(100,60,layers,converter.DEFAULTS))
    node=root.find("Image[@name='layer_1']")
    assert '+75*#scene_scale' in node.get('x') and node.get('rotation')=='-15'
    assert [item.get('x') for item in node.findall('PositionAnimation/Item')]==['-3*#scene_scale','-7*#scene_scale']
    assert node.get('src')=='assets/tilt.png'


def make_video(path):
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-f','lavfi','-i',
                    'color=c=red:size=64x32:rate=5:duration=1,drawbox=x=32:y=0:w=32:h=32:color=blue:t=fill',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(path)],check=True,capture_output=True)


def test_video_mirror_reencodes_unchanged_size_before_crop(tmp_path,monkeypatch):
    (tmp_path/'assets').mkdir();path=tmp_path/'assets/video.mp4';make_video(path)
    poster=Image.new('RGB',(64,32),'red');poster.paste('blue',(32,0,64,32));poster.save(tmp_path/'assets/poster.jpg')
    layers=[image_layer(asset='assets/poster.jpg',video='assets/video.mp4',x=32,y=16,w=64,h=32,rotation=0)]
    mirror=bridge.mirror_layers(tmp_path,layers,64)
    config={**converter.DEFAULTS,'预览宽度':64,'预览高度':32,'画面缩放':1,'感应幅度':0}
    filters=[];run=compression.subprocess.run
    def record(args,**kwargs):
        if '-vf' in args:filters.append(args[args.index('-vf')+1])
        return run(args,**kwargs)
    monkeypatch.setattr(compression.subprocess,'run',record)
    before=path.read_bytes()
    stats=compression.fit_layers(tmp_path,layers,config,64,32,mirror)
    assert stats['视频']==1 and path.read_bytes()!=before
    assert filters and filters[0].startswith('hflip,crop=64:32:0:0,')
    decoded=run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-i',str(path),'-frames:v','1',
                 '-f','rawvideo','-pix_fmt','rgb24','pipe:1'],check=True,capture_output=True).stdout
    image=Image.frombytes('RGB',(64,32),decoded)
    assert image.getpixel((8,16))[2]>220 and image.getpixel((8,16))[0]<25
    assert image.getpixel((56,16))[0]>220 and image.getpixel((56,16))[2]<25
    with Image.open(tmp_path/'assets/poster.jpg') as poster:
        assert poster.getpixel((8,16))[2]>220 and poster.getpixel((56,16))[0]>220


def export_request(tmp_path):
    (tmp_path/'scratch').mkdir()
    source=tmp_path/'原图.png';image=Image.new('RGB',(64,32),'red');image.paste('blue',(32,0,64,32));image.save(source)
    return {'operation':'export','theme':{'type':'image','source':str(source),'title':'镜像'},
            'draft':{'layout':{'flip':True,'scale':1,'x':.2,'y':.5,'clock':{'enabled':False,'rows':{}}}},
            'device':{'name':'测试机型','width':64,'height':32},'cacheRoot':str(tmp_path/'cache'),
            'scratchRoot':str(tmp_path/'scratch'),'outputDirectory':str(tmp_path/'output')}


def test_export_mirrors_stage_and_keeps_cached_source(tmp_path):
    request=export_request(tmp_path)
    cached=bridge.prepare(request)
    result=bridge.export(request);folder=Path(result['folder'])
    with Image.open(folder/cached['layers'][0]['asset']) as image:
        assert image.getpixel((8,16))[2]>200 and image.getpixel((56,16))[0]>200
    with Image.open(Path(cached['assetRoot'])/cached['layers'][0]['asset']) as image:
        assert image.getpixel((8,16))[0]>200 and image.getpixel((56,16))[2]>200
    report=json.loads((folder/'转换报告.json').read_text(encoding='utf-8'))
    assert report['配置']['水平翻转'] is True


def test_recorded_export_does_not_mirror_twice(tmp_path):
    request=export_request(tmp_path);path=tmp_path/'record.mp4';make_video(path)
    request.update(recording={'path':str(path),'width':64,'height':32,'fps':5,'duration':1},
                   theme={'type':'web','source':str(tmp_path/'index.html'),'title':'录制'})
    payload=bridge.prepare(request)
    assert payload['config']['水平翻转'] is False
    result=bridge.export(request)
    video=Path(result['folder'])/'assets/wallpaper.mp4'
    assert video.read_bytes()==path.read_bytes()
