// 独立发布入口为没有资源服务的宿主提供本次发布所选的材质。
import { mount as mountFrontend } from "neomega-r2-frontend";
import { openMaterialPack } from "neomega-r2-materials";
export * from "neomega-r2-frontend";

const bytes = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
export function mount(container, options) {
  return mountFrontend(container, {
    ...options,
    readResource: options.readResource ?? openMaterialPack(bytes(DEFAULT_PACK)),
    loadRecipe: options.loadRecipe ?? (async () => bytes(MATERIAL_RECIPE)),
  });
}
