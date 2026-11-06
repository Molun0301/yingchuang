"""将视频壁纸转成适合背屏播放的本地视频资源。"""
from pathlib import Path
from hashlib import sha256
import os
import subprocess
import tempfile
import imageio_ffmpeg


def extract_texture_video(data, directory, name):
    """按 TEX 容器索引读取视频，不在二进制中猜测文件头位置。"""
    from 背屏转换 import Reader,MAX_FILE
    r=Reader(data)
    if r.cstr()!="TEXV0005" or r.cstr()!="TEXI0001":raise ValueError("未知视频纹理版本")
    header=[r.i32() for _ in range(7)]
    kind=r.cstr()
    if not header[1]&32 or kind not in {"TEXB0003","TEXB0004"}:raise ValueError("不是支持的视频纹理")
    if r.u32()!=1:raise ValueError("视频纹理图像数量无效")
    r.i32()
    extended=kind=="TEXB0004" and r.u32()==1
    if r.u32()!=1:raise ValueError("视频纹理层级数量无效")
    if extended:
        if (r.u32(),r.u32())!=(1,2):raise ValueError("未知视频纹理参数")
        # TEXB0004 的条件说明以零字节结尾。
        r.take(data.index(b"\0",r.pos)-r.pos+1)
        if r.u32()!=1:raise ValueError("视频纹理条件数量无效")
    width,height,compressed,expected=(r.u32() for _ in range(4))
    payload=r.take(r.u32())
    if compressed:
        if compressed!=1 or expected>MAX_FILE:raise ValueError("视频纹理压缩信息无效")
        import lz4.block
        payload=lz4.block.decompress(payload,uncompressed_size=expected)
    if len(payload)<12 or payload[4:8]!=b"ftyp":raise ValueError("视频纹理内容不是 MP4")
    key=sha256(name.encode()+data[:91]+payload[:256]+str(len(payload)).encode()).hexdigest()[:24]
    destination=Path(directory)/(key+".mp4")
    if not destination.is_file():
        # 原始视频按源文件版本归属到媒体缓存；取消不会留下半个成品。
        with tempfile.NamedTemporaryFile(dir=directory,delete=False) as stream:
            staging=Path(stream.name);stream.write(payload)
        os.replace(staging,destination)
    return destination


def metadata(source):
    frames=imageio_ffmpeg.read_frames(str(source))
    try:return next(frames)
    finally:frames.close()


def poster(source,output):
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    command=[ffmpeg,"-hide_banner","-loglevel","error","-y","-i",str(source),"-frames:v","1","-vf","scale=1280:-2","-update","1",str(output)]
    result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:raise ValueError("无法读取视频画面。"+result.stderr.decode(errors="replace")[-200:])


def encode(source,output,fps=30,speed=1,event=None):
    info=metadata(source)
    duration=max(1,float(info.get("duration") or 1)/max(.25,float(speed)))
    # 小米视频元素限制单文件小于 50 MB，预留封装余量。
    bitrate=max(80000,min(3500000,int(44*1024*1024*8/duration)-96000))
    audio_filters="atempo=0.5,atempo="+str(speed/.5) if speed<.5 else "atempo="+str(speed)
    command=[imageio_ffmpeg.get_ffmpeg_exe(),"-hide_banner","-loglevel","error","-y","-i",str(source),
             "-map","0:v:0","-map","0:a?","-vf",f"setpts=PTS/{speed},fps={int(fps)},scale='min(1600,iw)':-2",
             "-c:v","libx264","-preset","fast","-c:a","aac","-b:a","96k","-af",audio_filters,
             "-b:v",str(bitrate),"-maxrate",str(bitrate),"-bufsize",str(bitrate*2),"-pix_fmt","yuv420p",
             "-movflags","+faststart","-progress","pipe:1",str(output)]
    error_log=tempfile.TemporaryFile()
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=error_log,text=True)
    try:
        for line in process.stdout:
            if line.startswith("out_time_us=") and event:
                try:event("压缩视频",min(91,25+int(float(line.split("=",1)[1])/1e6/duration*65)))
                except ValueError:pass
        code=process.wait();error_log.seek(0,2);error_log.seek(max(0,error_log.tell()-4096));error=error_log.read().decode('utf-8',errors='replace')
        if code:raise ValueError("视频转换未完成。"+error[-220:])
    finally:
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        error_log.close()
    if Path(output).stat().st_size>=50*1024*1024:raise ValueError("视频超过背屏文件大小限制，请缩短源视频。")
    return info
