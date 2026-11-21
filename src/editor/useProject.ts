// 编辑中的作品：所有修改经 update 进入历史，可撤销重做；停手 400 毫秒自动保存，关闭前 flush 立即落盘。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../types';

type History = { past: Project[]; present: Project | null; future: Project[]; key?: string; at: number; revision: number };
const LIMIT = 100;

export function useProject(id: string) {
  const [history, setHistory] = useState<History>({ past: [], present: null, future: [], at: 0, revision: 0 });
  const saved = useRef<Project | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), latest = useRef<Project | null>(null);
  latest.current = history.present;
  const load = useCallback((project: Project) => { saved.current = project; setHistory({ past: [], present: project, future: [], at: 0, revision: 0 }); }, []);
  /** key 相同且间隔很短的连续修改（拖动滑杆、拖动组件）合成一步撤销 */
  const update = useCallback((change: (project: Project) => void, key?: string) => setHistory(old => {
    if (!old.present) return old;
    const next = structuredClone(old.present); change(next);
    const now = Date.now(), merge = key !== undefined && key === old.key && now - old.at < 700;
    return { past: merge ? old.past : [...old.past, old.present].slice(-LIMIT), present: next, future: [], key, at: now, revision: old.revision + 1 };
  }), []);
  const undo = useCallback(() => setHistory(old => old.past.length && old.present
    ? { past: old.past.slice(0, -1), present: old.past[old.past.length - 1], future: [old.present, ...old.future], at: 0, revision: old.revision + 1 } : old), []);
  const redo = useCallback(() => setHistory(old => old.future.length && old.present
    ? { past: [...old.past, old.present], present: old.future[0], future: old.future.slice(1), at: 0, revision: old.revision + 1 } : old), []);
  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const project = latest.current;
    if (!project || project === saved.current) return;
    saved.current = project;
    await window.yingchuang.saveProject(id, project);
  }, [id]);
  useEffect(() => {
    if (!history.present || history.present === saved.current) return;
    timer.current = setTimeout(() => void save().catch(() => {}), 400);
    return () => clearTimeout(timer.current);
  }, [history.present, save]);
  return { project: history.present, revision: history.revision, load, update, undo, redo,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0, flush: save };
}
