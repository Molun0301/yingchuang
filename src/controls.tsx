import { Select } from './Select';
import { FolderOpen, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Property } from './types';
import { colorHex, sourceColor } from './conditions';

export function ColorWell({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}){
  const [text,setText]=useState(value);
  useEffect(()=>setText(value),[value]);
  return <span className="color-input"><input aria-label={label} type="color" value={value} onChange={e=>onChange(e.target.value)}/><input aria-label={`${label}色值`} className="hex-input" value={text} spellCheck={false} onChange={e=>{setText(e.target.value);if(/^#[\da-f]{6}$/i.test(e.target.value))onChange(e.target.value);}} onBlur={()=>{if(!/^#[\da-f]{6}$/i.test(text))setText(value);}}/></span>;
}

export function Slider({label,value,min,max,step=1,onChange,suffix='',digits=0}:{label:string;value:number;min:number;max:number;step?:number;onChange:(v:number)=>void;suffix?:string;digits?:number}){
  return <label className="slider-field"><span className="field-heading"><span>{label}</span><span className="number-field"><input aria-label={`${label}数值`} type="number" value={Number(value.toFixed(digits))} min={min} max={max} step={step} onChange={e=>{if(e.target.value!=='')onChange(Math.max(min,Math.min(max,Number(e.target.value))));}}/>{suffix}</span></span>
    <input aria-label={label} type="range" value={value} min={min} max={max} step={step} style={{'--range':`${(value-min)/(max-min)*100}%`} as React.CSSProperties} onChange={e=>onChange(Number(e.target.value))}/></label>;
}
export function Toggle({label,checked,onChange,hideLabel=false}:{label:string;checked:boolean;onChange:(value:boolean)=>void;hideLabel?:boolean}){
  return <label className="toggle-field"><span className={hideLabel?'sr-only':''}>{label}</span><input type="checkbox" role="switch" checked={checked} onChange={e=>onChange(e.target.checked)}/><span className="switch-track"/></label>;
}
export function PropertyControl({property,value,onChange}:{property:Property;value:unknown;onChange:(v:unknown)=>void}){
  const {label,type}=property;
  if(type==='group')return <div className="property-group">{label}</div>;
  if(type==='text')return null;
  if(type==='bool')return <Toggle label={label} checked={Boolean(value)} onChange={onChange}/>;
  if(type==='slider'){
    const fraction=property.fraction||property.step&&property.step<1;
    return <Slider label={label} value={Number(value)||0} min={Number(property.min??0)} max={Number(property.max??100)} step={property.step??(fraction?.valueOf()?0.01:1)} digits={property.precision??(fraction?2:0)} onChange={onChange}/>;
  }
  if(type==='color')return <label className="color-field"><span>{label}</span><ColorWell label={label} value={colorHex(value)} onChange={v=>onChange(sourceColor(v))}/></label>;
  if(type==='combo')return <label className="stack-field"><span>{label}</span><Select aria-label={label} value={String(value??'')} onChange={e=>{const found=property.options?.find(o=>String(o.value)===e.target.value);onChange(found?.value??e.target.value);}}>{property.options?.map((o,i)=><option key={i} value={String(o.value)}>{o.label}</option>)}</Select></label>;
  if(['file','directory','scenetexture','usershortcut'].includes(type))return <label className="stack-field"><span>{label}</span><span className="file-input"><input aria-label={label} value={String(value??'')} placeholder={type==='directory'?'选择目录':'选择文件'} onChange={e=>onChange(e.target.value)}/><button className="icon-button" aria-label={`选择${label}`} onClick={async()=>{const file=await window.yingchuang.chooseFile(type==='directory'?'directory':'asset');if(file)onChange(file);}}><FolderOpen size={15}/></button></span></label>;
  return <label className="stack-field"><span>{label}</span><input aria-label={label} value={typeof value==='object'?JSON.stringify(value):String(value??'')} onChange={e=>onChange(e.target.value)}/></label>;
}
export function ResetButton({onClick,label='恢复原主题'}:{onClick:()=>void;label?:string}){return <button className="icon-button subtle" title={label} aria-label={label} onClick={onClick}><RotateCcw size={14}/></button>;}
