// 参数组在不同世界之间复用同一套画面设置。坐标属于世界，材质资源由宿主管理。
import type { Camera } from "/r2/index.js";
import { appearanceDefaults, type Appearance } from "./appearance.js";
import { element, settingInputs } from "./hud.js";
import type { ViewSettings } from "./types.js";

const libraryKey = "neomega-r2-render-presets";
const format = "neomega-r2-render-preset";
type Preset = {
  format: typeof format;
  version: 1;
  name: string;
  camera: Pick<Camera, "yaw" | "pitch" | "ortho">;
  settings: ViewSettings & { appearance: Appearance };
};

/** 文件与本机列表使用同一格式；逐项读取，避免夹带宿主路径或场景坐标。 */
function capture(name: string, settings: ViewSettings, appearance: Appearance, camera: Preset["camera"]): Preset {
  const inputs = Object.fromEntries(settingInputs.map(([, key]) => [key, settings[key]])) as Pick<ViewSettings, typeof settingInputs[number][1]>;
  return {
    format, version: 1, name,
    camera: { yaw: camera.yaw, pitch: camera.pitch, ortho: camera.ortho },
    settings: {
      ...inputs, tier: settings.tier, timeFlow: settings.timeFlow, stillAccumulation: settings.stillAccumulation,
      appearance: { ...appearance },
    },
  };
}

/** 先按界面实际支持的范围校验整份文件，再一起应用；无效文件不会留下半套设置。 */
function decode(value: unknown): Preset {
  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("参数组格式不正确");
    return value as Record<string, unknown>;
  }
  const data = record(value);
  if (data.format !== format || data.version !== 1) throw Error("无法识别这份渲染参数组");
  if (typeof data.name !== "string" || !data.name.trim()) throw Error("参数组缺少名称");
  const s = record(data.settings), a = record(s.appearance), c = record(data.camera);
  // 旧参数组中的直射色调叠加在随太阳高度变化的预设上。
  if (!("autoSunColor" in a)) a.autoSunColor = true;
  function check(id: string, value: unknown) {
    const input = element<HTMLInputElement | HTMLSelectElement>(id);
    let valid: boolean;
    if (input instanceof HTMLSelectElement) {
      valid = typeof value === (id === "resolution" ? "string" : "number") && [...input.options].some(o => o.value === String(value));
    } else if (input.type === "checkbox") valid = typeof value === "boolean";
    else if (input.type === "color") valid = typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
    else valid = typeof value === "number" && Number.isFinite(value) && value >= Number(input.min) && value <= Number(input.max);
    if (!valid) throw Error("参数值无效：" + id);
  }
  for (const [id, key] of settingInputs) check(id, s[key]);
  for (const key of Object.keys(appearanceDefaults)) check(key, a[key]);
  if (typeof s.tier !== "string" || !["shading", "basic", "voxel"].includes(s.tier) ||
      typeof s.timeFlow !== "boolean" || typeof s.stillAccumulation !== "boolean" || (s.timeFlow && s.stillAccumulation))
    throw Error("渲染档位或时间设置无效");
  if (typeof c.yaw !== "number" || !Number.isFinite(c.yaw) || typeof c.pitch !== "number" || Math.abs(c.pitch) > Math.PI / 2 || !Number.isFinite(c.pitch))
    throw Error("相机方向无效");
  if (c.ortho !== undefined && (typeof c.ortho !== "number" || !Number.isFinite(c.ortho) || c.ortho <= 0)) throw Error("正交视野无效");
  const appearance = Object.fromEntries(Object.keys(appearanceDefaults).map(key => [key, a[key]])) as Appearance;
  return capture(data.name.trim(), s as unknown as ViewSettings, appearance, { yaw: c.yaw, pitch: c.pitch, ortho: c.ortho });
}

/** 在设置中管理本机参数组，文件选择与画面拖放共用同一条导入路径。 */
export function bindPresets(settings: ViewSettings, appearance: Appearance, camera: Camera, changed: () => void, notify: (message: string) => void) {
  const list = element<HTMLSelectElement>("preset-list"), dialog = element<HTMLDialogElement>("preset-dialog");
  const name = element<HTMLInputElement>("preset-name"), fileInput = element<HTMLInputElement>("preset-file");
  const load = element<HTMLButtonElement>("preset-load"), remove = element<HTMLButtonElement>("preset-delete");
  const events = new AbortController();
  let library: Preset[] = [], currentName = "";

  function refreshList(selected: string) {
    list.replaceChildren(...library.map(group => new Option(group.name, group.name)));
    if (!library.length) list.add(new Option("暂无参数组", ""));
    if (library.some(group => group.name === selected)) list.value = selected;
    list.disabled = load.disabled = remove.disabled = !library.length;
  }
  function readLibrary() {
    library = JSON.parse(localStorage.getItem(libraryKey) ?? "[]") as Preset[];
  }
  function defaultName() {
    let number = 1;
    while (library.some(group => group.name === "参数组-" + number)) number++;
    return "参数组-" + number;
  }
  function apply(group: Preset) {
    const { appearance: lighting, ...display } = group.settings;
    Object.assign(appearance, lighting);
    Object.assign(settings, display);
    camera.yaw = group.camera.yaw;
    camera.pitch = group.camera.pitch;
    camera.ortho = group.camera.ortho;
    currentName = group.name;
    changed();
    notify("已应用「" + group.name + "」");
  }
  function reload() {
    try { readLibrary(); } catch (error) { notify("无法读取本机参数组：" + error); }
    refreshList(list.value);
  }
  reload();
  window.addEventListener("storage", event => { if (!event.key || event.key === libraryKey) reload(); }, { signal: events.signal });
  element("preset-save").onclick = () => {
    name.value = defaultName();
    name.setCustomValidity("");
    dialog.showModal();
    name.select();
  };
  name.oninput = () => name.setCustomValidity("");
  element("preset-cancel").onclick = () => dialog.close();
  element<HTMLFormElement>("preset-form").onsubmit = event => {
    event.preventDefault();
    const title = name.value.trim();
    try {
      readLibrary();
      if (!title || library.some(group => group.name === title)) {
        name.setCustomValidity(title ? "已有同名参数组，请换一个名字" : "请输入名称");
        name.reportValidity();
        return;
      }
      const next = [...library, capture(title, settings, appearance, camera)];
      localStorage.setItem(libraryKey, JSON.stringify(next));
      library = next;
      currentName = title;
      refreshList(title);
      dialog.close();
      notify("已保存「" + title + "」");
    } catch (error) { notify("保存失败：" + error); }
  };
  load.onclick = () => {
    try { apply(decode(library[list.selectedIndex])); } catch (error) { notify(String(error)); }
  };
  remove.onclick = () => {
    const title = list.value;
    try {
      readLibrary();
      const next = library.filter(group => group.name !== title);
      localStorage.setItem(libraryKey, JSON.stringify(next));
      library = next;
      if (currentName === title) currentName = "";
      refreshList("");
      notify("已删除「" + title + "」");
    } catch (error) { notify("删除失败：" + error); }
  };
  element("preset-export").onclick = () => {
    const group = capture(currentName || defaultName(), settings, appearance, camera);
    const url = URL.createObjectURL(new Blob([JSON.stringify(group, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.download = group.name.replace(/[\\/:*?"<>|]/g, "_") + ".json";
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  async function importFile(file: File) {
    try { apply(decode(JSON.parse(await file.text()))); }
    catch (error) { notify("导入失败：" + error); }
  }
  element("preset-import").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    if (file) void importFile(file);
    fileInput.value = "";
  };
  // 打开存档的对话框有自己的拖放操作，交给它处理。
  window.addEventListener("dragover", event => {
    if (!document.querySelector("dialog[open]") && event.dataTransfer?.types.includes("Files")) event.preventDefault();
  }, { signal: events.signal });
  window.addEventListener("drop", event => {
    if (document.querySelector("dialog[open]") || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    const files = event.dataTransfer.files;
    if (files.length === 1 && /\.json$/i.test(files[0].name)) void importFile(files[0]);
    else notify("请拖入一个参数组 JSON 文件");
  }, { signal: events.signal });
  return () => events.abort();
}
