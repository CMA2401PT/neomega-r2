// HUD 负责坐标编辑、面板锚定、时间按钮与临时提示；不持有渲染器或存档请求。
import type { ViewSettings } from "./types.js";
/** 页面元素由固定 HTML 提供，各界面模块使用同一套 ID。 */
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw Error("界面缺少元素 " + id);
  return node as T;
}

/** 收起原生弹出面板，避免切换视图后留下顶层 UI。 */
export function closePopovers() {
  for (const panel of document.querySelectorAll<HTMLElement>(".popover:popover-open"))
    panel.hidePopover();
}

/** 让界面事件通过回调交给宿主，读数只在用户没有编辑时跟随相机。 */
export function createHUD({ settings, jump, changed }: { settings: ViewSettings; jump(position: number[]): void; changed(): void }) {
  const fields = ["x", "y", "z"].map(id => element<HTMLInputElement>(id)),
    form = element<HTMLFormElement>("teleport");
  let loaded = false,
    dirty = false,
    toastTimer: number | undefined,
    loadingTimer: number | undefined,
    wasLoading = false;
  /** 放弃编辑时恢复实时坐标，跳转按钮不再接收旧值。 */
  function stopEditing() {
    dirty = false;
    element<HTMLButtonElement>("teleport-go").disabled = true;
  }
  form.addEventListener("focusin", (event) => {
    element<HTMLButtonElement>("teleport-go").disabled = !loaded;
    if (event.target instanceof HTMLInputElement) event.target.select();
  });
  // 已修改的坐标即使暂时失焦也保留，直到跳转、按 Esc 或切换世界。
  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("focusout", event => {
    if (!dirty && !form.contains(event.relatedTarget as Node | null)) stopEditing();
  });
  form.onkeydown = (event) => {
    if (event.key === "Escape") {
      stopEditing();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  };
  element<HTMLButtonElement>("teleport-go").onmousedown = (event) => event.preventDefault();
  form.onsubmit = (event) => {
    event.preventDefault();
    const invalid = fields.find(field => !field.value.trim() || !Number.isFinite(Number(field.value)));
    if (invalid) { invalid.focus(); return; }
    jump(fields.map(field => Number(field.value)));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    stopEditing();
  };
  /** 面板位于触发按钮上方，屏幕边缘向内收。 */
  function place(panel: HTMLElement) {
    const trigger = document.querySelector(`[popovertarget="${panel.id}"]`);
    const rect = trigger!.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, rect.left + rect.width / 2 - panel.offsetWidth / 2))}px`;
    panel.style.bottom = `${innerHeight - element("hud").getBoundingClientRect().top + 8}px`;
    panel.dataset.placed = "";
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".popover")) {
    panel.addEventListener("toggle", (event) => {
      if (event.newState === "open") place(panel);
      else delete panel.dataset.placed;
    });
  }
  window.addEventListener("resize", () => {
    for (const panel of document.querySelectorAll<HTMLElement>(".popover:popover-open"))
      place(panel);
  });
  for (const [id, key] of [
    ["near-radius", "nearRadius"],
    ["far-radius", "farRadius"],
    ["resolution", "resolution"],
    ["speed", "speed"],
    ["fog", "fog"],
    ["photo-scale", "photoScale"],
    ["time", "time"],
  ] as const) {
    const input = element<HTMLInputElement | HTMLSelectElement>(id);
    if (input instanceof HTMLInputElement && key === "fog") input.checked = settings.fog;
    else input.value = String(settings[key]);
    input.addEventListener(id === "time" ? "input" : "change", () => {
      if (key === "fog") settings.fog = (input as HTMLInputElement).checked;
      else if (key === "resolution") settings.resolution = input.value;
      else settings[key] = Number(input.value);
      changed();
    });
  }
  // 静止时累积与动态时间互斥：时间在走画面就一直在变，累积不起来。打开其中一个时关掉另一个。
  const exclusive = { stillAccumulation: "timeFlow", timeFlow: "stillAccumulation" } as const;
  if (settings.stillAccumulation && settings.timeFlow) settings.stillAccumulation = false;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".tier"))
    button.onclick = () => {
      settings.tier = button.dataset.tier as ViewSettings["tier"];
      changed();
    };
  for (const [id, key] of [
    ["time-flow", "timeFlow"],
    ["still-accumulation", "stillAccumulation"],
  ] as const)
    element(id).onclick = () => {
      settings[key] = !settings[key];
      if (settings[key] && exclusive[key]) settings[exclusive[key]] = false;
      changed();
    };
  element<HTMLSelectElement>("resolution").options[0].textContent =
    `屏幕原生（${+devicePixelRatio.toFixed(2)}×）`;
  element<HTMLButtonElement>("eye").onclick = () => {
    const hidden = document.body.classList.toggle("hud-hidden");
    element<HTMLButtonElement>("eye").setAttribute("aria-pressed", String(hidden));
    element<HTMLButtonElement>("eye").title = element<HTMLButtonElement>("eye").ariaLabel = hidden
      ? "显示 HUD"
      : "隐藏 HUD";
    closePopovers();
  };
  return {
    /** 设置读数与按下态来自同一份设置，时间流动时也可刷新。 */
    settings() {
      element<HTMLOutputElement>("near-value").textContent = `${settings.nearRadius} 区块`;
      element<HTMLOutputElement>("far-value").textContent = `${settings.farRadius} 区块`;
      for (const [id, key] of [
        ["time-flow", "timeFlow"],
        ["still-accumulation", "stillAccumulation"],
      ] as const)
        element(id).setAttribute("aria-pressed", String(settings[key]));
      for (const button of document.querySelectorAll<HTMLButtonElement>(".tier"))
        button.setAttribute("aria-pressed", String(button.dataset.tier === settings.tier));
      // 面板不显示时刻文字，悬停滑块时仍能看到具体时间。
      const minutes = Math.floor(settings.time * 60) % 1440;
      element<HTMLInputElement>("time").title =
        `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      element<HTMLInputElement>("time").value = String(settings.time);
    },
    /** 存档切换只影响依赖存档的操作。 */
    world(world: { loaded: boolean }) {
      loaded = world.loaded;
      if (document.activeElement instanceof HTMLElement && form.contains(document.activeElement)) document.activeElement.blur();
      for (const field of [...fields, element<HTMLButtonElement>("map-open")]) field.disabled = !loaded;
      stopEditing();
      clearTimeout(loadingTimer);
      wasLoading = false;
      element<HTMLOutputElement>("loading").textContent = "";
    },
    /** 坐标字段按数字长度展开，不为较大的世界坐标预留固定空白。 */
    position(position: number[]) {
      if (dirty || form.contains(document.activeElement)) return;
      fields.forEach((field, i) => {
        field.value = position[i].toFixed(1);
        field.style.width = `${Math.max(3, field.value.length) + 0.8}ch`;
      });
    },
    /** 重连提示与加载进度共用位置，恢复连接后继续显示加载进度并正常淡出。 */
    loading(stats: import("/r2/index.js").SessionStats, connection?: {state: string}) {
      const waiting = connection && connection.state !== "connected";
      const busy = waiting || stats.pending > 0 || stats.nearPending > 0;
      if (busy) {
        clearTimeout(loadingTimer);
        element<HTMLOutputElement>("loading").classList.remove("faded");
        element<HTMLOutputElement>("loading").textContent = waiting
          ? connection.state === "reconnecting"
            ? "连接已断开，保留最后画面；每 3 秒重试"
            : "数据源已断开"
          : `近景对象准备 ${stats.nearPending} 个 r2region · 远景覆盖 ${stats.loaded}/${stats.wanted} 个 r2region`;
      } else if (wasLoading) {
        element<HTMLOutputElement>("loading").textContent = "已加载";
        loadingTimer = setTimeout(
          () => element<HTMLOutputElement>("loading").classList.add("faded"),
          1500,
        );
      }
      wasLoading = busy;
    },
    /** 错误保持可读的短时提示，后来的错误替换先前内容。 */
    error(message: string) {
      clearTimeout(toastTimer);
      element("notice").textContent = message;
      element("notice").hidden = false;
      toastTimer = setTimeout(() => (element("notice").hidden = true), 5000);
    },
  };
}
