// HUD 负责坐标编辑、面板锚定、时间按钮与临时提示；不持有渲染器或存档请求。
import type { SessionStats } from "neomega-r2-core";
import type { ViewSettings } from "./types.ts";
import { closePopovers, element } from "./dom.ts";
import { bindSettingsSheet } from "./settings-sheet.ts";

export { closePopovers, element };

/** 可随参数组保存的显示与操作控件，以同一份映射读写界面和文件。 */
export const settingInputs = [
  ["near-radius", "nearRadius"],
  ["far-radius", "farRadius"],
  ["resolution", "resolution"],
  ["speed", "speed"],
  ["fog", "fog"],
  ["super-resolution", "superResolution"],
  ["accumulation-filter", "accumulationFilter"],
  ["save-sr-2x", "saveSuperResolution2x"],
  ["photo-scale", "photoScale"],
  ["photo-supersample", "photoSupersample"],
  ["export-scale", "exportScale"],
  ["export-supersample", "exportSupersample"],
  ["time", "time"],
] as const;

/** 让界面事件通过回调交给宿主，读数只在用户没有编辑时跟随相机。 */
export function createHUD({ settings, jump, changed }: { settings: ViewSettings; jump(position: number[]): void; changed(key?: keyof ViewSettings): void }) {
  // 帮助使用模态窗口，阅读时暂停场景键盘操作，关闭后由浏览器归还焦点。
  const help = element<HTMLDialogElement>("help");
  element("help-open").onclick = () => {
    closePopovers();
    help.showModal();
  };
  help.onkeydown = event => event.stopPropagation();
  const fields = ["x", "y", "z"].map(id => element<HTMLInputElement>(id)),
    form = element<HTMLFormElement>("teleport");
  let loaded = false,
    dirty = false,
    toastTimer: number | undefined,
    loadingTimer: number | undefined,
    wasLoading = false,
    hadRegionFailure = false;
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
  /** 场景信息之类的小弹窗对准触发按钮，贴在底部坐标栏上方。设置面板由 bindSettingsSheet 自行布局。 */
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
  bindSettingsSheet();
  for (const [id, key] of settingInputs) {
    const input = element<HTMLInputElement | HTMLSelectElement>(id);
    input.addEventListener(id === "time" ? "input" : "change", () => {
      if (key === "fog" || key === "saveSuperResolution2x") settings[key] = (input as HTMLInputElement).checked;
      else if (key === "resolution") settings.resolution = input.value;
      else if (key === "superResolution") settings.superResolution = input.value as ViewSettings["superResolution"];
      else if (key === "accumulationFilter") settings.accumulationFilter = input.value as NonNullable<ViewSettings["accumulationFilter"]>;
      else settings[key] = Number(input.value);
      changed(key);
    });
  }
  /** 参数组一次修改多个字段，控件在应用后一起回显。 */
  function syncInputs() {
    for (const [id, key] of settingInputs) {
      const input = element<HTMLInputElement | HTMLSelectElement>(id);
      if (key === "fog" || key === "saveSuperResolution2x") (input as HTMLInputElement).checked = !!settings[key];
      else if (key === "resolution" && input instanceof HTMLSelectElement) {
        // 旧参数组可能含有菜单之外的自定义倍率。
        if (![...input.options].some(option => option.value === settings.resolution))
          input.add(new Option("窗口尺寸 " + Number(Number(settings.resolution).toFixed(3)) + "×", settings.resolution));
        input.value = settings.resolution;
      }
      else input.value = String(settings[key]);
    }
  }
  syncInputs();
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
      if (settings[key]) settings[exclusive[key]] = false;
      changed(key);
    };
  // 隐藏后按钮换成划掉的眼睛，表示 HUD 当前收起；按钮本身不显示按下态。
  const eye = element<HTMLButtonElement>("eye");
  eye.onclick = () => {
    const hidden = document.body.classList.toggle("hud-hidden");
    eye.querySelector("use")!.setAttribute("href", hidden ? "#i-eye-off" : "#i-eye");
    eye.title = eye.ariaLabel = hidden ? "显示 HUD" : "隐藏 HUD";
    closePopovers();
  };
  return {
    syncInputs,
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
      // 时间滑条仅向读屏软件报告具体时刻。
      const minutes = Math.floor(settings.time * 60) % 1440;
      const clock =
        `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const slider = element<HTMLInputElement>("time");
      if (slider.getAttribute("aria-valuetext") !== clock) {
        slider.setAttribute("aria-valuetext", clock);
      }
      slider.value = String(settings.time);
    },
    /** 存档切换只影响依赖存档的操作。 */
    world(world: { loaded: boolean }) {
      loaded = world.loaded;
      if (document.activeElement instanceof HTMLElement && form.contains(document.activeElement)) document.activeElement.blur();
      for (const field of [...fields, element<HTMLButtonElement>("map-open")]) field.disabled = !loaded;
      stopEditing();
      clearTimeout(loadingTimer);
      clearTimeout(toastTimer);
      wasLoading = false;
      hadRegionFailure = false;
      element("notice").hidden = true;
      element<HTMLOutputElement>("loading").textContent = "";
    },
    /** 坐标字段至少容纳 -100.0 这样的六位读数，移动时底栏不随位数抖动；更大的坐标再展开。 */
    position(position: number[]) {
      if (dirty || form.contains(document.activeElement)) return;
      fields.forEach((field, i) => {
        field.value = position[i].toFixed(1);
        field.style.width = `${Math.max(6, field.value.length)}ch`;
      });
    },
    /** 失败区域不再算等待；错误持续可见，直到数据恢复或离开这些区域。 */
    loading(stats: SessionStats, connection?: {state: string}) {
      const waiting = connection && connection.state !== "connected";
      const busy = waiting || stats.pending > 0 || stats.nearPending > 0;
      if (stats.failed > 0) {
        clearTimeout(toastTimer);
        element("notice").textContent = stats.failure ?? "部分区域读取失败，请检查存档格式或数据是否完整。";
        element("notice").hidden = false;
      } else if (hadRegionFailure) {
        element("notice").hidden = true;
      }
      hadRegionFailure = stats.failed > 0;
      if (busy || hadRegionFailure) {
        clearTimeout(loadingTimer);
        element<HTMLOutputElement>("loading").classList.remove("faded");
        element<HTMLOutputElement>("loading").textContent = waiting
          ? connection.state === "reconnecting"
            ? "连接已断开，保留最后画面；每 3 秒重试"
            : "数据源已断开"
          : hadRegionFailure
            ? `${stats.failed} 个区域加载失败，存档显示不完整${busy ? ` · 其余区域仍在加载` : ""}`
            : `近景对象准备 ${stats.nearPending} 个 r2region · 远景覆盖 ${stats.loaded}/${stats.wanted} 个 r2region`;
      } else if (wasLoading) {
        element<HTMLOutputElement>("loading").textContent = "已加载";
        loadingTimer = setTimeout(
          () => element<HTMLOutputElement>("loading").classList.add("faded"),
          1500,
        );
      }
      wasLoading = busy || hadRegionFailure;
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
