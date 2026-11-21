// 设置：外观、机型、导出位置、壁纸目录、排版模板、关于与更新。
import { useState } from 'react';
import { CloudFog, Droplets, Sun, Moon, SunMoon, LayoutGrid, Grid3x3, FolderOpen, Plus, X, Pencil, Trash2, Check } from 'lucide-react';
import type { AppState, Device } from '../types';
import { Glass, type Appearance } from '../appearance';
import { Segmented, type ToastKind } from '../ui';
import { Toggle } from '../controls';
import { TemplateThumbnail } from '../TemplateThumbnail';
import { UpdateSettingsSection, type useUpdater } from '../Updater';

/** 机型示意：按真机比例画出背屏、圆角与镜头位置 */
function DeviceArt({ device }: { device: Device }) {
  return <span className="device-art" style={{ aspectRatio: `${device.width} / ${device.height}`, borderRadius: `${device.cornerRadius / device.width * 100}% / ${device.cornerRadius / device.height * 100}%` }}>
    <span className="device-safe" style={{ width: `${device.safeLeft * 100}%` }}/>
    {device.camera.ys.map(y => <i key={y} style={{ left: `${device.camera.x / device.width * 100}%`, top: `${y / device.height * 100}%`, width: `${device.camera.r * 2 / device.width * 100}%` }}/>)}
  </span>;
}

type Props = { state: AppState; setState: (state: AppState) => void; merge: (value: Partial<AppState>) => void; appearance: Appearance; setAppearance: (patch: Partial<Appearance>) => void;
  notify: (message: string, kind?: ToastKind) => void; updater: ReturnType<typeof useUpdater>; onAddDirectory: () => void };

export function SettingsPage({ state, setState, merge, appearance, setAppearance, notify, updater, onAddDirectory }: Props) {
  const [renaming, setRenaming] = useState(''), [name, setName] = useState('');
  return <div className="content-scroll settings-page">
    <Glass as="section" refraction={false} className="settings-section"><h2>外观</h2>
      <div className="material-cards">{([['frosted', '磨砂玻璃', '半透明白底，柔和模糊，层次安静', CloudFog], ['liquid', '液态玻璃', '近乎无色的透镜，边缘折射与镜面高光', Droplets]] as const).map(([key, label, note, Icon]) => <button key={key} className="material-card" aria-pressed={appearance.material === key} onClick={() => setAppearance({ material: key })}><div className={`material-preview ${key}`}><span className="mp-blob"/><span className="mp-panel"/><span className="mp-pill"/></div><b><Icon size={15}/>{label}</b><small>{note}</small></button>)}</div>
      <div className="settings-row"><div><h3>配色</h3></div><Segmented label="配色" value={appearance.scheme} onChange={value => setAppearance({ scheme: value })} options={[{ value: 'system', label: '跟随系统', icon: <SunMoon size={13}/> }, { value: 'light', label: '浅色', icon: <Sun size={13}/> }, { value: 'dark', label: '深色', icon: <Moon size={13}/> }]}/></div>
      <div className="settings-row"><div><h3>环境光</h3><p>用当前壁纸的封面给界面染色</p></div><Toggle label="环境光" hideLabel checked={appearance.ambient} onChange={value => setAppearance({ ambient: value })}/></div>
      <div className="settings-row"><div><h3>卡片密度</h3></div><Segmented label="卡片密度" value={appearance.density} onChange={value => setAppearance({ density: value })} options={[{ value: 'comfortable', label: '舒展', icon: <LayoutGrid size={13}/> }, { value: 'compact', label: '紧凑', icon: <Grid3x3 size={13}/> }]}/></div>
    </Glass>
    <Glass as="section" refraction={false} className="settings-section"><h2>机型</h2>
      <div className="device-cards">{state.devices.map(device => <button key={device.id} className="device-card" aria-pressed={state.settings.deviceId === device.id} onClick={async () => merge(await window.yingchuang.settings({ deviceId: device.id }))}>
        <DeviceArt device={device}/><b>{device.name}</b><small>{device.width} × {device.height}</small></button>)}</div>
    </Glass>
    <Glass as="section" refraction={false} className="settings-section"><h2>导出</h2>
      <div className="settings-row"><div><h3>保存位置</h3><p className="path-text" title={state.settings.outputDirectory}>{state.settings.outputDirectory}</p></div>
        <div className="row-actions"><button className="text-button" onClick={() => void window.yingchuang.openOutput()}><FolderOpen size={14}/>打开</button><button className="button secondary" onClick={async () => { const next = await window.yingchuang.chooseDirectory('output'); if (next) setState(next); }}>更改</button></div></div>
    </Glass>
    <Glass as="section" refraction={false} className="settings-section"><div className="settings-section-heading"><h2>壁纸目录</h2><button className="text-button" onClick={onAddDirectory}><Plus size={15}/>添加</button></div>
      {state.roots.map(root => <div className="directory-row" key={root}><FolderOpen size={18}/><div><span title={root}>{root}</span><small>自动发现</small></div></div>)}
      {state.settings.roots.map(root => <div className="directory-row" key={'manual-' + root}><FolderOpen size={18}/><div><span title={root}>{root}</span><small>手动添加</small></div><button className="icon-button" aria-label={`移除目录 ${root}`} onClick={async () => setState(await window.yingchuang.removeDirectory(root))}><X size={16}/></button></div>)}
    </Glass>
    <Glass as="section" refraction={false} className="settings-section"><h2>排版模板</h2>
      <div className="template-list">{state.templates.map(template => <div className="template-row" key={template.id}><TemplateThumbnail template={template} compact/>
        {renaming === template.id ? <form className="template-name" onSubmit={async e => { e.preventDefault(); merge(await window.yingchuang.renameTemplate(template.id, name.trim() || template.name)); setRenaming(''); }}>
          <input autoFocus aria-label="模板名称" value={name} onChange={e => setName(e.target.value)}/><button type="submit" className="icon-button" aria-label="保存名称"><Check size={16}/></button><button type="button" className="icon-button" aria-label="取消" onClick={() => setRenaming('')}><X size={14}/></button></form>
          : <div className="template-row-name"><b>{template.name}</b><small>{template.builtin ? '内置' : '我的排版'}</small></div>}
        {!template.builtin && renaming !== template.id && <div className="row-actions"><button className="icon-button" aria-label={`重命名 ${template.name}`} title="重命名" onClick={() => { setRenaming(template.id); setName(template.name); }}><Pencil size={14}/></button>
          <button className="icon-button" aria-label={`删除模板 ${template.name}`} title="删除" onClick={async () => { merge(await window.yingchuang.deleteTemplate(template.id)); notify('模板已删除', 'info'); }}><Trash2 size={15}/></button></div>}
      </div>)}</div>
    </Glass>
    <UpdateSettingsSection updater={updater} version={state.version}/>
  </div>;
}
