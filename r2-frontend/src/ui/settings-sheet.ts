// 设置面板贴在屏幕一侧并按页签分组，打开时收起底栏和方向键，把画面尽量留给渲染结果。
import { element } from "./dom.ts";

/** 横屏贴右侧；右侧放不下工具栏加面板时占满整列；竖屏或窄窗口改为底部抽屉。 */
type SheetLayout = "side" | "side-full" | "bottom";

const tabKey = "neomega-r2-settings-tab";
/** 面板在工具栏下方至少要有这么高，否则改为占满右侧整列并临时收起工具栏。 */
const MIN_SIDE_HEIGHT = 340;

function chooseLayout(toolbar: HTMLElement): SheetLayout {
  if (innerWidth < 600 || innerWidth < innerHeight) return "bottom";
  const below = innerHeight - toolbar.getBoundingClientRect().bottom - 22;
  return below >= MIN_SIDE_HEIGHT ? "side" : "side-full";
}

export function bindSettingsSheet() {
  const sheet = element("settings"),
    toolbar = element("toolbar"),
    opener = element<HTMLButtonElement>("settings-open"),
    tabs = [...sheet.querySelectorAll<HTMLButtonElement>("[role=tab]")];

  /** 只显示一个页签的内容；记住上次的页签，下次打开直接回到那里。 */
  function select(name: string) {
    const tab = tabs.find(item => item.dataset.tab === name) ?? tabs[0];
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      element(item.getAttribute("aria-controls")!).hidden = !selected;
    }
    try { localStorage.setItem(tabKey, tab.dataset.tab!); } catch {}
  }
  for (const tab of tabs) tab.onclick = () => select(tab.dataset.tab!);
  // 左右方向键在页签之间移动，与系统分段控件的键盘习惯一致。
  sheet.querySelector<HTMLElement>("[role=tablist]")!.onkeydown = (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    const index = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
    const next = tabs[(index + step + tabs.length) % tabs.length];
    select(next.dataset.tab!);
    next.focus();
  };
  let saved: string | null = null;
  try { saved = localStorage.getItem(tabKey); } catch {}
  select(saved ?? "camera");

  /** 布局写在 body 上，样式据此收起其余 HUD，并让提示避开面板。 */
  function place() {
    const layout = chooseLayout(toolbar);
    document.body.dataset.sheet = layout;
    document.body.style.setProperty("--sheet-top", `${toolbar.getBoundingClientRect().bottom + 8}px`);
  }
  sheet.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState === "open") place();
  });
  sheet.addEventListener("toggle", (event) => {
    const open = (event as ToggleEvent).newState === "open";
    if (!open) delete document.body.dataset.sheet;
    opener.setAttribute("aria-pressed", String(open));
  });
  window.addEventListener("resize", () => {
    if (sheet.matches(":popover-open")) place();
  });
  // 面板不随点击画面关闭，焦点在面板里时 Esc 关闭它并把焦点还给设置按钮。
  sheet.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    sheet.hidePopover();
    if (opener.checkVisibility()) opener.focus();
  });
}
