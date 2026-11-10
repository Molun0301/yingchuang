// 与主进程共用 desktop/framing.cjs，避免两份取景公式各自漂移。
import shared from '../../desktop/framing.cjs';
export type Framing = { scale: number; left: number; top: number; marginX: number; marginY: number };
type Layout = { scale: number; x: number; y: number };
export const frameScene: (sceneWidth: number, sceneHeight: number, width: number, height: number, layout: Layout, amount: number, vertical: number, motion?: number) => Framing = shared.frameScene;
export const recordSize: (width: number, height: number, framing: Framing) => { width: number; height: number } = shared.recordSize;
