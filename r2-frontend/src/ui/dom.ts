declare const R2_LAYOUT_HTML: string | undefined;

/** 页面元素由标准布局提供，各界面模块使用同一套 ID。 */
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw Error("界面缺少元素 " + id);
  return node as T;
}

/** 收起原生弹出面板（含设置面板），避免切换视图后留下顶层 UI。 */
export function closePopovers() {
  for (const panel of document.querySelectorAll<HTMLElement>("[popover]:popover-open")) {
    panel.hidePopover();
  }
}

export interface LayoutSlots {
  leadingActions?: string | Node;
  actions?: string | Node;
  settingsExtra?: string | Node;
  helpExtra?: string | Node;
}

const slotNames = [
  ["leading-actions", "leadingActions"],
  ["actions", "actions"],
  ["settings-extra", "settingsExtra"],
  ["help-extra", "helpExtra"],
] as const;

function resolveSlotContent(name: string, override?: string | Node): Node | null {
  if (override !== undefined) {
    if (typeof override !== "string") return override;
    const template = document.createElement("template");
    template.innerHTML = override;
    return template.content;
  }
  const extra = document.getElementById(name);
  if (extra instanceof HTMLTemplateElement) {
    extra.remove();
    return extra.content;
  }
  return null;
}

/** 挂载共享查看界面布局，并按插槽名填入宿主提供的控件、额外设置或帮助内容。 */
export function mountLayout(slots: LayoutSlots = {}, layoutHTML?: string) {
  const html = layoutHTML ?? (typeof R2_LAYOUT_HTML !== "undefined" ? R2_LAYOUT_HTML : "");
  if (!html) throw Error("缺少界面布局模板，请传 layoutHTML 或使用打包入口");
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const [slotName, optionKey] of slotNames) {
    const slot = template.content.querySelector(`slot[name="${slotName}"]`);
    if (!slot) continue;
    const content = resolveSlotContent(slotName, slots[optionKey]);
    if (content) slot.replaceWith(content);
    else slot.remove();
  }
  document.body.prepend(template.content);
}
