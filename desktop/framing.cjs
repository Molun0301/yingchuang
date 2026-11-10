// 预览、录制与背屏清单共用同一套取景公式，保证三处看到的画幅一致。

/** 计算场景在背屏上的缩放与左上角位置；留边用于感应位移，避免倾斜时露出边缘。 */
function frameScene(sceneWidth, sceneHeight, width, height, layout, amount, vertical, motion = 1) {
  const marginX = amount * motion, marginY = marginX * vertical;
  const scale = Math.max(width * (1 + 2 * marginX) / sceneWidth, height * (1 + 2 * marginY) / sceneHeight) * layout.scale;
  const left = Math.min(-width * marginX, Math.max(width - sceneWidth * scale + width * marginX, (width - sceneWidth * scale) * layout.x));
  const top = Math.min(-height * marginY, Math.max(height - sceneHeight * scale + height * marginY, (height - sceneHeight * scale) * layout.y));
  return { scale, left, top, marginX, marginY };
}

/** 录制画幅：屏幕加上两侧感应留边，取偶数满足 H.264 的 4:2:0 采样。 */
function recordSize(width, height, framing) {
  const even = value => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * (1 + 2 * framing.marginX)), height: even(height * (1 + 2 * framing.marginY)) };
}

module.exports = { frameScene, recordSize };
