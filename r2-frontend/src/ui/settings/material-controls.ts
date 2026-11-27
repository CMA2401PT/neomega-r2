import type { TextureSet } from "neomega-r2-core";
import { compileMaterialPack, materialDirectory, type MaterialInput } from "neomega-r2-materials";
import { element } from "../layout/dom.ts";

declare const R2_MATERIAL_CONTROLS: string | undefined;


export interface MaterialControlsOptions {
  /** 用户切换材质时调用，宿主可以读取网络或本地配方。 */
  loadRecipe: (signal: AbortSignal) => Promise<Uint8Array>;
  initialLimit?: number;
  controlsHTML?: string;
}

/** 查看器和可嵌入前端共用文件选择、合成与安装顺序。只有成功换包后才记住选择。 */
export function materialControls(
  container: HTMLElement,
  install: (set: TextureSet, input: Exclude<MaterialInput, File[]>, limit: number) => Promise<void>,
  options: MaterialControlsOptions,
) {
  const html = options.controlsHTML ?? (typeof R2_MATERIAL_CONTROLS !== "undefined" ? R2_MATERIAL_CONTROLS : "");
  if (!html) throw Error("缺少材质控制面板模板");
  container.innerHTML = html;
  const file = element<HTMLInputElement>("texture-file"),
    directory = element<HTMLInputElement>("texture-files");
  const size = element<HTMLSelectElement>("texture-size"),
    status = element("texture-status");
  size.value = String(options.initialLimit ?? 128);
  let selected: MaterialInput = null;
  let previous = Promise.resolve();
  let task: AbortController | undefined;
  let cachedRecipe: Uint8Array | undefined;

  async function loadRecipe(signal: AbortSignal): Promise<Uint8Array> {
    if (cachedRecipe) return cachedRecipe;
    cachedRecipe = await options.loadRecipe(signal);
    return cachedRecipe;
  }

  function apply(input: MaterialInput, limit = Number(size.value)): Promise<void> {
    task?.abort();
    const current = (task = new AbortController());
    status.textContent = "正在合成材质…";
    // 已进入 GPU 安装阶段的换包须完成后才能提交下一套区域表。
    const run = previous.then(async () => {
      current.signal.throwIfAborted();
      const pack = Array.isArray(input) ? materialDirectory(input) : input;
      const recipe = await loadRecipe(current.signal);
      current.signal.throwIfAborted();
      const set = await compileMaterialPack(recipe, pack, limit, current.signal);
      current.signal.throwIfAborted();
      await install(set, pack, limit);
      current.signal.throwIfAborted();
      selected = pack;
      size.value = String(limit);
      const name = pack?.name;
      status.textContent = (name ?? "默认材质") + " · " + set.info.side + "×" + set.info.side;
    });
    previous = run.catch((error) => {
      if (!current.signal.aborted) status.textContent = String(error);
    });
    return run;
  }
  function choose(input: MaterialInput) {
    void apply(input).catch(() => {});
  }
  element("texture-browse").onclick = () => file.click();
  element("texture-directory").onclick = () => directory.click();
  file.onchange = () => {
    if (file.files?.length) choose(file.files[0]);
    file.value = "";
  };
  directory.onchange = () => {
    if (directory.files?.length) choose([...directory.files]);
    directory.value = "";
  };
  element("texture-reset").onclick = () => choose(null);
  size.onchange = () => choose(selected);
  return { apply, dispose: () => task?.abort() };
}
