import { element } from "./hud.js";

/** 可选的场景调试面板，demo 与离线建筑预览共用。 */
export function mountRenderDebug(panel: HTMLElement) {
  panel.innerHTML = `
      <h3>场景调试</h3>
      <label class="setting">求交显示<select id="debug">
        <option value="0">正常画面</option>
        <option value="1">遍历 / 求交热图</option>
        <option value="2">求交路径</option>
      </select></label>
      <label class="setting">空域与均匀立方体跳跃<input id="hierarchy" class="switch" type="checkbox" checked /></label>
      <label class="setting">跨格片段<input id="fragments" class="switch" type="checkbox" checked /></label>
      <output id="status" class="hint"></output>
  `;
  const debug = element<HTMLSelectElement>("debug");
  const hierarchy = element<HTMLInputElement>("hierarchy");
  const fragments = element<HTMLInputElement>("fragments");
  return {
    status: element<HTMLOutputElement>("status"),
    drawOptions: () => ({ debug: Number(debug.value), hierarchy: hierarchy.checked, fragments: fragments.checked }),
  };
}
