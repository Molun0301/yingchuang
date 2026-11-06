"""读取平面蒙皮网格并离线生成透明动画帧。"""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import ctypes
import os
import sys
import math
import struct

import numpy as np
from PIL import Image


@dataclass
class Rig:
    positions: np.ndarray
    joints: np.ndarray
    weights: np.ndarray
    uv: np.ndarray
    triangles: np.ndarray
    parents: list[int]
    inverse_bind: np.ndarray
    tracks: np.ndarray
    fps: float
    frame_count: int
    mode: str


def mesh_data(data):
    version = int(data[4:8])
    flags_in_header, material_count, mesh_count = struct.unpack_from("<III", data, 9)
    if (material_count,mesh_count)!=(1,1):
        raise ValueError("暂仅支持单材质单网格骨骼")
    end_name = data.index(b"\0",21)+1
    flags, = struct.unpack_from("<I",data,end_name)
    offset = end_name+4+(4 if flags&2 else 0)+(24 if version>=17 else 0)
    tag = flags_in_header
    if version>=16:
        tag,=struct.unpack_from("<I",data,offset)
        offset+=4
    if tag&~0x0181002F or tag&0x01800008!=0x01800008:
        raise ValueError("骨骼顶点属性不受支持")
    stride=12
    fields={}
    for bit,size,name in ((2,12,None),(4,16,None),(0x10000,4,None),(0x800000,16,"joints"),
                          (0x1000000,16,"weights"),(32,16,None),(8,8,"uv")):
        if tag&bit:
            if name:
                fields[name]=stride
            stride+=size
    n,=struct.unpack_from("<I",data,offset)
    start=offset+4
    if not 0<n<=8192*stride or n%stride:
        raise ValueError("骨骼顶点区长度无效")
    vertex_type=np.dtype({"names":["xyz","joints","weights","uv"],
                          "formats":[("<f4",3),("<u4",4),("<f4",4),("<f4",2)],
                          "offsets":[0,fields["joints"],fields["weights"],fields["uv"]],"itemsize":stride})
    mesh=np.frombuffer(data,vertex_type,count=n//stride,offset=start)
    index_bytes,=struct.unpack_from("<I",data,start+n)
    width=4 if flags&1 else 2
    start+=n+4
    if not index_bytes or index_bytes%(3*width) or start+index_bytes>len(data):
        raise ValueError("骨骼索引区长度无效")
    indices=np.frombuffer(data,f"<u{width}",count=index_bytes//width,offset=start).reshape(-1,3)
    if indices.max()>=len(mesh):
        raise ValueError("骨骼三角形索引超出顶点数")
    return mesh,indices,start+index_bytes


def read_bones(data,offset):
    start=data.index(b"MDLS",offset)
    end,count=struct.unpack_from("<II",data,start+9)
    if not start<end<=len(data) or not 1<=count<=96:
        raise ValueError("骨骼块长度无效")
    cursor=start+18
    parents,worlds=[],[]
    for i in range(count):
        _,parent,length=struct.unpack_from("<IiI",data,cursor)
        if not -1<=parent<i or length!=64:
            raise ValueError("骨骼父级或矩阵无效")
        local=np.frombuffer(data,"<f4",count=16,offset=cursor+12).reshape(4,4).T
        parents.append(parent)
        worlds.append(local if parent<0 else worlds[parent]@local)
        # 约束与骨骼名是两个变长字符串，旧格式最后一根骨骼可以省略名字。
        tail=data.index(b"\0",cursor+76,end)
        cursor=tail+1
        if i<count-1:
            cursor=data.index(b"\0",cursor,end)+1
    if not np.all(np.isfinite(worlds)):
        raise ValueError("骨骼绑定矩阵含无效数字")
    return parents,np.linalg.inv(worlds),cursor


def read_clip(data, offset, clip_id, joint_count):
    start=data.index(b"MDLA",offset)
    end,count=struct.unpack_from("<II",data,start+9)
    if not start<end<=len(data) or not 1<=count<=64:
        raise ValueError("动画块长度无效")
    cursor=start+17
    for clip_number in range(count):
        # 多段动画之间可能带填充，按有效剪辑头读取下一段。
        for offset in range(cursor,min(end,cursor+(1 if clip_number==0 else 65))):
            try:
                ident,reserved=struct.unpack_from("<II",data,offset)
                if reserved or not ident:
                    continue
                first=data.index(b"\0",offset+8,min(end,offset+1024))+1
                stop=data.index(b"\0",first,min(end,first+12))
                mode=data[first:stop].decode("ascii")
                if mode not in {"loop","mirror","single"}:
                    continue
                fps,frame_count,_,channels=struct.unpack_from("<fIII",data,stop+1)
                if 1<=fps<=120 and 1<=frame_count<=2400 and channels==joint_count:
                    cursor=stop+17
                    break
            except (ValueError,struct.error):
                continue
        else:
            raise ValueError("骨骼动画头不受支持")
        tracks=[]
        for _ in range(joint_count):
            _,length=struct.unpack_from("<II",data,cursor)
            cursor+=8
            if not 36<=length<=(frame_count+1)*36 or length%36 or cursor+length>end:
                raise ValueError("骨骼动画轨道长度无效")
            if ident==clip_id:
                track=np.frombuffer(data,"<f4",count=length//4,offset=cursor).reshape(-1,9)
                if len(track)<frame_count+1:
                    track=np.pad(track,((0,frame_count+1-len(track)),(0,0)),mode="edge")
                tracks.append(track)
            cursor+=length
        if ident==clip_id:
            if mode=="single":
                raise ValueError("单次骨骼动画暂未支持")
            return np.array(tracks),fps,frame_count,mode
    raise ValueError("找不到已启用的骨骼动画")


def decode_rig(data, clip_id):
    if len(data)>8*1024*1024 or len(data)<32 or data[:4]!=b"MDLV" or not 13<=int(data[4:8])<=23:
        raise ValueError("骨骼资源版本不受支持")
    mesh,indices,cursor=mesh_data(data)
    parents,inverse_bind,cursor=read_bones(data,cursor)
    tracks,fps,frame_count,mode=read_clip(data,cursor,clip_id,len(parents))
    if mesh["joints"].max()>=len(parents) or not np.allclose(mesh["weights"].sum(axis=1),1,atol=.01):
        raise ValueError("骨骼索引或蒙皮权重无效")
    for values in (mesh["xyz"],mesh["uv"],mesh["weights"],tracks):
        if not np.all(np.isfinite(values)):
            raise ValueError("骨骼资源含无效数字")
    return Rig(mesh["xyz"],mesh["joints"],mesh["weights"],mesh["uv"],indices,
               parents,inverse_bind,tracks,fps,frame_count,mode)


def skin_pose(rig, phase, blend=1.0):
    period=rig.frame_count*(2 if rig.mode=="mirror" else 1)
    frame=phase%period
    if rig.mode=="mirror":
        frame=min(frame,period-frame)
    i = min(int(frame),rig.frame_count-1)
    amount = frame - i
    keys = rig.tracks[:, i] * (1 - amount) + rig.tracks[:, i + 1] * amount
    keys = rig.tracks[:, 0] + (keys - rig.tracks[:, 0]) * blend
    world = []
    for parent, key in zip(rig.parents, keys):
        tx, ty, tz, rx, ry, rz, sx, sy, sz = key
        cx, cy, cz = math.cos(rx), math.cos(ry), math.cos(rz)
        nx, ny, nz = math.sin(rx), math.sin(ry), math.sin(rz)
        # 原动画使用局部平移和 Z、Y、X 顺序的欧拉旋转。
        local = np.array([
            [cz * cy * sx, (cz * ny * nx - nz * cx) * sy, (cz * ny * cx + nz * nx) * sz, tx],
            [nz * cy * sx, (nz * ny * nx + cz * cx) * sy, (nz * ny * cx - cz * nx) * sz, ty],
            [-ny * sx, cy * nx * sy, cy * cx * sz, tz],
            [0, 0, 0, 1],
        ])
        world.append(local if parent < 0 else world[parent] @ local)
    matrices = np.asarray(world) @ rig.inverse_bind
    vertices = np.column_stack((rig.positions, np.ones(len(rig.positions))))
    moved = np.einsum("vbij,vj->vbi", matrices[rig.joints], vertices)
    return np.einsum("vb,vbi->vi", rig.weights, moved)[:, :2]


@lru_cache(maxsize=1)
def native_raster():
    if os.environ.get("YINGCHUANG_RUNTIME"):directory=Path(os.environ["YINGCHUANG_RUNTIME"])
    elif getattr(sys,"frozen",False):directory=Path(sys.executable).parent
    elif os.environ.get("YINGCHUANG_CORE"):directory=Path(os.environ["YINGCHUANG_CORE"]).parent/"runtime"
    else:directory=Path(__file__).resolve().parents[1]/"runtime"/("win" if sys.platform=="win32" else "linux")
    library=ctypes.CDLL(str(directory/("scene-raster.dll" if sys.platform=="win32" else "scene-raster.so")))
    function=library.raster_mesh
    pointer=ctypes.c_void_p
    function.argtypes=[pointer,pointer,pointer,ctypes.c_int,pointer,ctypes.c_int,ctypes.c_int,pointer,ctypes.c_int,ctypes.c_int]
    function.restype=None
    return function


def raster_frame(rig, positions, texture, size, bounds):
    """原生三角形光栅化，保留网格重叠的透明混合顺序。"""
    w,h=size
    left,bottom,right,top=bounds
    points=np.ascontiguousarray((positions-[left,top])*[w/(right-left),-h/(top-bottom)],dtype=np.float32)
    uv=np.ascontiguousarray(rig.uv,dtype=np.float32)
    if not np.isfinite(points).all() or not np.isfinite(uv).all():
        raise ValueError('骨骼坐标或纹理坐标不是有限数字')
    triangles=np.ascontiguousarray(rig.triangles,dtype=np.int32)
    texture=np.ascontiguousarray(texture,dtype=np.uint8)
    frame=np.zeros((h,w,4),dtype=np.float32)
    native_raster()(points.ctypes.data,uv.ctypes.data,triangles.ctypes.data,len(triangles),
                    texture.ctypes.data,texture.shape[1],texture.shape[0],frame.ctypes.data,w,h)
    frame[:,:,:3]/=np.maximum(frame[:,:,3:],1e-8)
    return Image.fromarray(np.clip(np.rint(frame*255),0,255).astype(np.uint8))


def bilinear(texture, u, v, repeat=False):
    """按照归一化坐标采样纹理，处理重复和钳制边界。"""
    h, w = texture.shape[:2]
    x, y = u * w - .5, v * h - .5
    if not repeat:
        x = np.clip(x, 0, w - 1)
        y = np.clip(y, 0, h - 1)
    left, top = np.floor(x).astype(np.intp), np.floor(y).astype(np.intp)
    dx, dy = (x - left)[..., None], (y - top)[..., None]
    right, bottom = left + 1, top + 1
    if repeat:
        left, right, top, bottom = left % w, right % w, top % h, bottom % h
    else:
        right, bottom = np.minimum(right, w - 1), np.minimum(bottom, h - 1)
    return ((texture[top, left] * (1 - dx) + texture[top, right] * dx) * (1 - dy)
            + (texture[bottom, left] * (1 - dx) + texture[bottom, right] * dx) * dy)


def render_cycle(rig, image, rate, blend, output_fps=16, layout_size=None, first_only=False):
    if not 0 < rate <= 4 or not 0 <= blend <= 1:
        raise ValueError("骨骼播放倍率或权重无效")
    period=rig.frame_count*(2 if rig.mode=="mirror" else 1)
    duration=period/(rig.fps*rate)
    if duration>80:
        raise ValueError("骨骼循环过长")
    limit=max(12,min(240,200000//len(rig.triangles)))
    frames=max(2,min(limit,math.ceil(duration*output_fps)))
    poses=[skin_pose(rig,i*period/frames,blend) for i in range(1 if first_only else frames)]
    sw,sh=layout_size or image.size
    low = np.minimum(np.min(poses, axis=(0, 1)) - 2, [-sw / 2, -sh / 2])
    high = np.maximum(np.max(poses, axis=(0, 1)) + 2, [sw / 2, sh / 2])
    bounds = (*low, *high)
    resize=min(1,(220 if max(sw,sh)<850 else 512)/max(high-low))
    size = tuple(np.ceil((high - low) * resize).astype(int))
    texture = np.array(image.convert("RGBA"))
    for p in poses:
        yield raster_frame(rig, p, texture, size, bounds), bounds, round(duration * 1000)
