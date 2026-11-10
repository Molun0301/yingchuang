"""用独立像素与实际媒体验证图层、首帧和纹理转换边界。"""
import json
from pathlib import Path
import struct
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image
import imageio_ffmpeg

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'core'))
import 应用桥接 as bridge
import 背屏转换 as converter
from 骨骼动画 import raster_frame
from 视频处理 import extract_texture_video,metadata


@pytest.mark.parametrize('alpha,expected',[(0,(255,0,0,255)),(128,(127,0,128,255)),(255,(0,0,255,255))])
def test_overlapping_mesh_keeps_underlying_pixels_without_diagonal_seam(alpha,expected):
    positions=np.array([[0,0],[8,0],[8,8],[0,8]]*2,dtype=float)
    triangles=np.array([[0,1,2],[0,2,3],[4,5,6],[4,6,7]])
    uv=np.array([[.25,.5]]*4+[[.75,.5]]*4)
    texture=np.array([[[255,0,0,255],[0,0,255,alpha]]],dtype=np.uint8)
    rig=SimpleNamespace(uv=uv,triangles=triangles)
    image=raster_frame(rig,positions,texture,(8,8),(0,0,8,8))
    assert set(image.getdata())=={expected}


def test_nonfinite_texture_coordinate_is_rejected_before_native_render():
    rig=SimpleNamespace(uv=np.array([[float('nan'),0],[1,0],[0,1]]),triangles=np.array([[0,1,2]]))
    with pytest.raises(ValueError,match='有限数字'):
        raster_frame(rig,np.array([[0,0],[8,0],[0,8]]),np.zeros((2,2,4),dtype=np.uint8),(8,8),(0,0,8,8))


def test_scalar_parent_scale_keeps_children_and_checkbox_parallax():
    objects=[{'id':1,'origin':'10 20 0','scale':.5},{'id':2,'parent':1,'origin':'4 6 0','parallaxDepth':True}]
    notes=[];worlds=converter.world_transforms(objects,{},100,100,notes)
    assert notes==[]
    assert worlds[2]['matrix']==(.5,0,0,.5,12,23)
    assert worlds[2]['depth']==1


def test_engine_font_is_visible_to_theme_font_resolver(tmp_path):
    theme=tmp_path/'主题';theme.mkdir();(theme/'scene.json').write_text('{}')
    engine=tmp_path/'引擎';(engine/'fonts').mkdir(parents=True)
    data=b'font-resource';(engine/'fonts/原字体.ttf').write_bytes(data)
    package=bridge.EditablePackage(converter.SceneFolder(theme/'scene.json'),{},[engine])
    assert package.has('fonts/原字体.ttf')
    assert package.read('fonts/原字体.ttf')==data


def request_for_scene(tmp_path,image_path='materials/picture.png'):
    source=tmp_path/'主题';(source/'materials').mkdir(parents=True);(source/'models').mkdir()
    (source/'project.json').write_text(json.dumps({'title':'day 图层','type':'scene'}))
    (source/'scene.json').write_text(json.dumps({'general':{'orthogonalprojection':{'width':64,'height':48}},
        'objects':[{'id':42,'name':'day','image':'models/image.json','size':'64 48','origin':'32 24 0'}]}))
    (source/'models/image.json').write_text(json.dumps({'material':'materials/image.json'}))
    (source/'materials/image.json').write_text(json.dumps({'passes':[{'shader':'genericimage4','textures':[image_path]}]}))
    (tmp_path/'jobs').mkdir()
    draft={'layout':{'scale':1.06,'x':.5,'y':.5,'clock':{'enabled':False,'rows':{}}},'motion':{'fps':30},'properties':{},'layers':{}}
    return {'operation':'preview','theme':{'type':'scene','source':str(source/'scene.json'),'title':'day 图层'},'draft':draft,
            'device':{'width':976,'height':596,'name':'测试机型'},'cacheRoot':str(tmp_path/'cache'),
            'scratchRoot':str(tmp_path/'jobs'),'outputDirectory':str(tmp_path/'导出')}


def test_image_named_day_is_not_removed_as_a_clock(tmp_path):
    request=request_for_scene(tmp_path)
    source=Path(request['theme']['source']).parent
    Image.new('RGBA',(64,48),'#ae2356').save(source/'materials/picture.png')
    preview=bridge.prepare(request,fast=True)
    assert [layer['id'] for layer in preview['layers']]==[42]
    with Image.open(Path(preview['assetRoot'])/preview['layers'][0]['asset']) as image:
        assert image.convert('RGBA').getpixel((30,20))==(174,35,86,255)
    assert preview['progressive'] is True


def video_texture(payload,version,extended=False):
    header=b'TEXV0005\0TEXI0001\0'+struct.pack('<7i',0,34,64,48,64,48,0)
    header+=f'TEXB000{version}\0'.encode()+struct.pack('<Ii',1,-1)
    if version==4:header+=struct.pack('<I',int(extended))
    header+=struct.pack('<I',1)
    if extended:header+=struct.pack('<II',1,2)+b'{"visible":true}\0'+struct.pack('<I',1)
    return header+struct.pack('<5I',64,48,0,0,len(payload))+payload


@pytest.mark.parametrize('version,extended',[(3,False),(4,False),(4,True)])
def test_embedded_video_uses_container_index(version,extended,tmp_path):
    payload=b'\0\0\0\x18ftypmp42'+b'\0'*32
    output=extract_texture_video(video_texture(payload,version,extended),tmp_path,'视频')
    assert output.read_bytes()==payload
    with pytest.raises(ValueError):extract_texture_video(video_texture(payload,version,extended)[:-4],tmp_path,'截断')


def test_video_scene_preview_and_export_keep_actual_video(tmp_path,monkeypatch):
    # 本测试核对视频原样保留，导出压缩的裁切由 test_画质压缩.py 覆盖。
    import 画质压缩;monkeypatch.setattr(画质压缩,'fit_layers',lambda *args:{})
    original=tmp_path/'source.mp4'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=5',
                    '-t','1','-c:v','libx264','-pix_fmt','yuv420p',str(original)],check=True)
    request=request_for_scene(tmp_path,'materials/embedded.tex')
    source=Path(request['theme']['source']).parent
    (source/'materials/embedded.tex').write_bytes(video_texture(original.read_bytes(),4))
    preview=bridge.prepare(request,fast=True);layer=preview['layers'][0]
    assert layer['id']==42 and Path(layer['videoSource']).read_bytes()==original.read_bytes()
    request['operation']='export';result=bridge.export(request)
    folder=Path(result['folder']);video=next((folder/'assets').glob('*.mp4'))
    assert metadata(video)['source_size']==(64,48)
    assert metadata(video)['duration']>.8
    assert Path(result['path']).is_file()
