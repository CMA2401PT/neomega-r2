import { element } from "./dom.ts";

export interface Startup {
  stage(message: string): Promise<void>;
  finish(): void;
  fail(error: unknown, title?: string): void;
}

/** 让状态先出现在屏幕上，再进入可能同步阻塞的显卡调用。 */
function paintStartup() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** 创建启动状态控制器。必须在布局 DOM 挂载之后调用。 */
export function createStartup(): Startup {
  const panel = element("startup-status");
  const label = element("startup-stage");
  const elapsed = element("startup-elapsed");
  const started = performance.now();
  let active = true;
  const ticker = setInterval(() => {
    elapsed.textContent = `已等待 ${Math.floor((performance.now() - started) / 1000)} 秒`;
  }, 1000);

  return {
    async stage(message: string) {
      if (!active) return;
      label.textContent = message;
      await paintStartup();
    },
    finish() {
      if (!active) return;
      active = false;
      clearInterval(ticker);
      panel.hidden = true;
    },
    fail(error: unknown, title = "启动失败") {
      active = false;
      clearInterval(ticker);
      panel.hidden = false;
      label.textContent = title;
      elapsed.textContent = String(error);
    },
  };
}
