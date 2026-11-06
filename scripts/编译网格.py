"""生成随转换器分发的网格渲染库，构建工具不进入安装包。"""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]


def build(platform):
    directory=ROOT/'runtime'/platform;directory.mkdir(parents=True,exist_ok=True)
    name='scene-raster.dll' if platform=='win' else 'scene-raster.so'
    if platform=='win':
        compiler=[sys.executable,'-m','ziglang','cc','-target','x86_64-windows-gnu']
    else:
        compiler=['cc','-fPIC']
    subprocess.check_call([*compiler,'-O3','-s','-shared',str(ROOT/'core/网格渲染.c'),'-o',str(directory/name),'-lm'])
    (directory/'scene-raster.pdb').unlink(missing_ok=True)
    return directory/name


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('platform',choices=['linux','win'])
    print(build(parser.parse_args().platform))
