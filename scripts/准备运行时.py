"""把转换器及依赖随桌面应用打包，用户无需单独安装 Python。"""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[1]


def linux_runtime():
    work=ROOT/'build/pyinstaller';work.mkdir(parents=True,exist_ok=True)
    destination=ROOT/'runtime/linux'
    args=[sys.executable,'-I','-m','PyInstaller','--noconfirm','--clean','--onedir','--name','converter-worker',
          '--distpath',str(work/'dist'),'--workpath',str(work/'work'),'--specpath',str(work),
          '--paths',str(ROOT/'core'),'--collect-all','fontTools','--collect-all','imageio_ffmpeg',
          '--exclude-module','tkinter','--exclude-module','pytest','--exclude-module','IPython',
          '--add-data',str(ROOT/'core/预览模板.html')+':.',str(ROOT/'core/应用桥接.py')]
    with (ROOT/'build/转换运行时.log').open('w') as log:subprocess.check_call(args,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
    if destination.exists():shutil.rmtree(destination)
    shutil.copytree(work/'dist/converter-worker',destination)
    # 使用桌面系统已有的标准运行库，避免带入构建机较新的 glibc 依赖。
    for name in ('libstdc++.so.6','libgcc_s.so.1'):
        library=destination/'_internal'/name
        if library.exists():library.unlink()
    print('Linux 转换运行时已生成：'+str(destination),flush=True)


def windows_runtime():
    cache=ROOT/'build/windows-downloads';cache.mkdir(parents=True,exist_ok=True)
    archive=cache/'python-3.12.10-embed-amd64.zip'
    if not archive.exists():urllib.request.urlretrieve('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',archive)
    destination=ROOT/'runtime/win';destination.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(archive) as package:package.extractall(destination)
    wheels=cache/'wheels';wheels.mkdir(exist_ok=True)
    subprocess.check_call([sys.executable,'-I','-m','pip','download','--disable-pip-version-check','--only-binary=:all:',
                           '--platform','win_amd64','--python-version','312','--implementation','cp','--abi','cp312',
                           '--dest',str(wheels),'-r',str(ROOT/'core/requirements.txt')],cwd=ROOT)
    site=destination/'Lib/site-packages';site.mkdir(parents=True,exist_ok=True)
    for wheel in wheels.glob('*.whl'):
        with zipfile.ZipFile(wheel) as package:
            for name in package.namelist():
                if name.endswith('/'):continue
                parts=Path(name).parts
                if parts[0].endswith('.data'):
                    if len(parts)<3 or parts[1] not in {'purelib','platlib'}:continue
                    target=site/Path(*parts[2:])
                else:target=site/name
                target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(package.read(name))
    (destination/'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n',encoding='utf-8')
    print('Windows 转换运行时已生成：'+str(destination),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('platform',choices=['linux','win']);args=parser.parse_args()
    if args.platform=='linux':linux_runtime()
    else:windows_runtime()
