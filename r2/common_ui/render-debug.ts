import { element } from "./hud.js";

/** 让共享查看器从调试页读取当前的射线诊断选项。 */
export function mountRenderDebug(panel: HTMLElement, onChange?: () => void) {
  panel.innerHTML = `
      <h3>场景调试</h3>
      <label class="setting">求交显示<select id="debug">
        <option value="0">正常画面</option>
        <option value="1">遍历 / 求交热力图</option>
        <option value="2">求交路径</option>
      </select></label>
      <p class="hint">热力图中，红色越亮表示遍历步数越多，绿色越亮表示模型面测试次数越多。求交路径中，红色表示测试过模型面，绿色表示命中且未测试模型面。</p>
      <label class="setting">空域与均匀立方体跳跃<input id="hierarchy" class="switch" type="checkbox" checked /></label>
      <label class="setting">跨格片段<input id="fragments" class="switch" type="checkbox" checked /></label>
      <p class="hint">关闭跳跃可观察逐格遍历的开销。关闭跨格片段可辨认模型伸入相邻格子的部分。</p>
      <output id="status" class="hint"></output>
  `;
  // 切换遍历方式后重新计时，让调试页读数反映当前设置。
  if (onChange) panel.addEventListener("change", onChange);
  const debug = element<HTMLSelectElement>("debug");
  const hierarchy = element<HTMLInputElement>("hierarchy");
  const fragments = element<HTMLInputElement>("fragments");
  return {
    status: element<HTMLOutputElement>("status"),
    drawOptions: () => ({ debug: Number(debug.value), hierarchy: hierarchy.checked, fragments: fragments.checked }),
  };
}
