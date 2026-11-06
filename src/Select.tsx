import { Children, isValidElement, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

type Option = { value:string; label:string; group:string; disabled:boolean };
type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>,'onChange'> & {onChange?:(event:{target:{value:string}})=>void};
function optionsFrom(children:ReactNode,group=''):Option[]{
  return Children.toArray(children).flatMap(child=>{
    if(!isValidElement<{value?:unknown;children?:ReactNode;label?:string;disabled?:boolean}>(child))return [];
    if(child.type==='optgroup')return optionsFrom(child.props.children,child.props.label||'');
    if(child.type!=='option')return optionsFrom(child.props.children,group);
    const label=Children.toArray(child.props.children).join('');
    return [{value:String(child.props.value??label),label,group,disabled:Boolean(child.props.disabled)}];
  });
}

export function Select({children,value,onChange,disabled,className='',...props}:Props){
  const options=useMemo(()=>optionsFrom(children),[children]);
  const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[active,setActive]=useState(0);
  const [position,setPosition]=useState<React.CSSProperties>({});
  const button=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null);
  const id=useId(),label=props['aria-label']||'选择选项';
  const selected=options.find(o=>o.value===String(value??''));
  const shown=options.filter(o=>o.label.toLowerCase().includes(search.toLowerCase()));
  const choose=(option:Option)=>{if(option.disabled)return;onChange?.({target:{value:option.value}});setOpen(false);button.current?.focus();};
  useLayoutEffect(()=>{
    if(!open)return;
    const rect=button.current!.getBoundingClientRect(),below=window.innerHeight-rect.bottom-12,above=rect.top-12;
    const downward=below>=Math.min(300,above),width=Math.min(Math.max(rect.width,200),window.innerWidth-20);
    setPosition({position:'fixed',left:Math.min(Math.max(10,rect.left),window.innerWidth-width-10),width,
      ...(downward?{top:rect.bottom+5}:{bottom:window.innerHeight-rect.top+5}),maxHeight:Math.max(90,Math.min(340,downward?below:above))});
    setSearch('');setActive(Math.max(0,options.findIndex(o=>o.value===String(value??''))));
    const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!menu.current?.contains(target)&&!button.current?.contains(target))setOpen(false);};
    const resize=()=>setOpen(false);
    document.addEventListener('pointerdown',outside);window.addEventListener('resize',resize);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',resize);};
  },[open]);
  useEffect(()=>{
    if(!open)return;
    if(options.length>12)input.current?.focus();else menu.current?.focus();
  },[open,options.length]);
  useEffect(()=>{menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[active,open]);
  return <span className={`select-control ${className}`}>
    <button ref={button} type="button" className="select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" disabled={disabled}
      onClick={()=>setOpen(!open)} onKeyDown={event=>{if(['ArrowDown','ArrowUp','Enter',' '].includes(event.key)){event.preventDefault();setOpen(true);}}}>
      <span>{selected?.label||'请选择'}</span><ChevronDown size={13}/>
    </button>
    {open&&createPortal(<div ref={menu} className="select-popup" style={position} tabIndex={-1} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);button.current?.focus();}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(i=>Math.max(0,Math.min(shown.length-1,i+(event.key==='ArrowDown'?1:-1))));}
      if(event.key==='Enter'&&shown[active]){event.preventDefault();choose(shown[active]);}
      if(event.key==='Home'&&event.target===menu.current){event.preventDefault();setActive(0);}
      if(event.key==='End'&&event.target===menu.current){event.preventDefault();setActive(shown.length-1);}
      if(event.key==='Tab')setOpen(false);
    }}>
      {options.length>12&&<label className="select-search"><Search size={14}/><input ref={input} aria-label={`搜索${label}`} placeholder="输入名称筛选" value={search} onChange={event=>{setSearch(event.target.value);setActive(0);}}/></label>}
      <div id={id} className="select-options" role="listbox" aria-label={label} aria-activedescendant={shown[active]?`${id}-${active}`:undefined}>
        {shown.map((option,index)=><div key={`${option.value}-${index}`}>
          {option.group&&option.group!==shown[index-1]?.group&&<div className="select-group">{option.group}</div>}
          <button type="button" role="option" id={`${id}-${index}`} data-index={index} tabIndex={-1} aria-selected={option.value===String(value??'')} disabled={option.disabled}
            className={`select-option ${index===active?'highlighted':''}`} onMouseMove={()=>setActive(index)} onClick={()=>choose(option)}>
            <span>{option.label}</span>{option.value===String(value??'')&&<Check size={14}/>}
          </button>
        </div>)}
        {!shown.length&&<div className="select-empty">没有匹配的选项</div>}
      </div>
    </div>,document.body)}
  </span>;
}
