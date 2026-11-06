"""生成可公开复测的界面样例，不携带创意工坊资源。"""
import json
import os
from pathlib import Path
import shutil
from PIL import Image,ImageDraw

root=Path(__file__).resolve().parents[1]/'test-results/窗口样例'
(root/'materials').mkdir(parents=True,exist_ok=True)
(root/'models').mkdir(exist_ok=True);(root/'fonts').mkdir(exist_ok=True)
font=Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts/arial.ttf'
if not font.is_file():font=Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
shutil.copyfile(font,root/'fonts/source.ttf')
image=Image.new('RGBA',(976,596),'#334b78');draw=ImageDraw.Draw(image)
draw.ellipse((450,100,800,450),fill='#b8cee8');image.save(root/'materials/picture.png');image.convert('RGB').save(root/'preview.jpg')
project={'title':'窗口回归样例','type':'scene','file':'scene.json','preview':'preview.jpg','general':{'properties':{
    'mode':{'type':'combo','text':'样例下拉列表','value':'0','options':[{'label':'选项 '+str(i),'value':str(i)} for i in range(25)]}}}}
scene={'general':{'orthogonalprojection':{'width':976,'height':596}},'objects':[
    {'id':1,'name':'day','image':'models/picture.json','size':'976 596','origin':'488 298 0'},
    {'id':2,'name':'time','text':'12:34','font':'fonts/source.ttf','pointsize':42,'origin':'700 300 0','size':'300 100'}]}
for name,data in [('project.json',project),('scene.json',scene),('models/picture.json',{'material':'materials/picture.json'}),
                  ('materials/picture.json',{'passes':[{'shader':'genericimage4','textures':['picture.png']} ]})]:
    (root/name).write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
print(root)
