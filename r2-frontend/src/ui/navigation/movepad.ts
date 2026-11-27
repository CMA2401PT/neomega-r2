// 触屏按钮只管理按住与松开的生命周期，移动方向和速度交给飞行控制器。
/** 指针捕获允许手指按住按钮的同时用另一根手指拖动场景。 */
import type { Move, FlightControls } from "./controls.ts";
export function bindMovePad(pad: HTMLElement, controls: FlightControls, signal?: AbortSignal) {
  for (const button of pad.querySelectorAll<HTMLButtonElement>("[data-move]")) {
    const move = button.dataset.move as Move;
    /** 系统取消或失去捕获时也松开，避免方向键粘住。 */
    const release = () => {
      controls.hold({ move, down: false });
      delete button.dataset.held;
    };
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      controls.canvas.focus();
      button.setPointerCapture(event.pointerId);
      button.dataset.held = "";
      controls.hold({ move, down: true });
    }, { signal });
    button.addEventListener("pointerup", release, { signal });
    button.addEventListener("pointercancel", release, { signal });
    button.addEventListener("lostpointercapture", release, { signal });
    button.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
    window.addEventListener("blur", release, { signal });
  }
}
