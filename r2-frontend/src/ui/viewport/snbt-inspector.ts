import type { OverlayItem, SceneOverlay } from "../../compositor/overlay-types.ts";
import { element } from "../layout/dom.ts";
import type { ViewerWorld } from "../player/world.ts";

/** 手套开启时跟踪近景方块并允许拾取。关闭或切换世界时只移除检查器自己的线框。 */
export function createSNBTInspector(overlay: SceneOverlay, mapOpen: () => boolean) {
  const button = element<HTMLButtonElement>("inspect-snbt");
  const dialog = element<HTMLDialogElement>("block-entity");
  const regions = new Map<string, Map<string, OverlayItem>>();
  let world: ViewerWorld | null = null;
  let unsubscribe: (() => void) | undefined;
  let request = 0;

  function disable(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    request++;
    dialog.close();
    for (const blocks of regions.values()) for (const item of blocks.values()) item.remove();
    regions.clear();
    button.setAttribute("aria-pressed", "false");
  }

  button.onclick = () => {
    if (unsubscribe) return disable();
    if (!world) return;
    unsubscribe = world.watchBlockPositions((region, positions) => {
      const previous = regions.get(region);
      const current = new Map<string, OverlayItem>();
      for (const position of positions) {
        const key = position.join("/");
        current.set(key, previous?.get(key) ?? overlay.blockOutline(position, { stroke: "#e44741", strokeWidth: 1.5 }));
      }
      for (const [key, item] of previous ?? []) if (!current.has(key)) item.remove();
      if (current.size) regions.set(region, current);
      else regions.delete(region);
    });
    button.setAttribute("aria-pressed", "true");
  };

  return {
    setWorld(next: ViewerWorld | null): void {
      if (world === next) return;
      disable();
      world = next;
      button.disabled = !world;
    },
    async pick(...[camera, pixel]: Parameters<ViewerWorld["pick"]>): Promise<void> {
      if (!world || !unsubscribe || mapOpen()) return;
      const current = ++request;
      const hit = await world.pick(structuredClone(camera), pixel);
      if (!hit || current !== request || mapOpen()) return;
      const snbt = world.snbt(hit);
      if (snbt === undefined) return;
      element("block-entity-title").textContent = (hit.entityId === undefined ? "方块 SNBT · " : "实体 SNBT · ") + hit.position.join(", ");
      element("block-entity-text").textContent = snbt;
      dialog.showModal();
    },
  };
}
