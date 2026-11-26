import type { Frontend, MountOptions } from "./frontend-types.ts";

declare const R2_VIEW_HTML: string;
declare const R2_VIEW_SCRIPT: string;

/** 将独立查看界面挂到有尺寸的容器。内部文档隔离控件 ID、样式、键盘和动画生命周期。 */
export async function mount(container: HTMLElement, options: MountOptions): Promise<Frontend> {
  const frame = document.createElement("iframe");
  frame.title = "方块世界";
  frame.allow = "fullscreen";
  frame.style.cssText = "display:block;width:100%;height:100%;border:0";
  const script = URL.createObjectURL(new Blob([R2_VIEW_SCRIPT], { type: "text/javascript" }));
  const marker = options.actions?.ownerDocument.createComment("R2 操作区");
  if (marker) options.actions!.before(marker);
  function remove() {
    if (marker?.parentNode) marker.replaceWith(options.actions!);
    frame.remove();
  }
  try {
    const ready = new Promise<void>((resolve) => {
      frame.onload = () => resolve();
    });
    frame.srcdoc = R2_VIEW_HTML + '<script src="' + script + '"></script>';
    container.append(frame);
    await ready;
    const child = frame.contentWindow as Window & {
      R2Player: { start(options: MountOptions): Promise<Frontend> };
    };
    const player = await child.R2Player.start(options);
    let disposed = false;
    return {
      ...player,
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          player.dispose();
        } finally {
          remove();
        }
      },
    };
  } catch (error) {
    remove();
    throw error;
  } finally {
    URL.revokeObjectURL(script);
  }
}
