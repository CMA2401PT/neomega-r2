import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// 内存 DOM 只提供 HUD 实际使用的控件；假时钟验证五秒后仍显示错误，不依赖浏览器端口。
test("区域错误持续显示，恢复或切换世界后清除", async (t) => {
  const result = await build({ entryPoints: [new URL("../common_ui/hud.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
  const { createHUD } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  class Element {
    hidden = true;
    textContent = "";
    dataset = {};
    style = {};
    options = [{}];
    classes = new Set();
    classList = { remove: (name) => this.classes.delete(name), add: (name) => this.classes.add(name) };
    addEventListener() {}
    contains() { return false; }
    setAttribute() {}
    getAttribute(name) { return name === "aria-controls" ? "camera-panel" : null; }
    querySelectorAll(selector) { return selector === "[role=tab]" ? [tab] : []; }
    querySelector() { return new Element(); }
  }
  const tab = new Element();
  tab.dataset.tab = "camera";
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    activeElement: null,
  };
  const globals = { document, window: { addEventListener() {} }, HTMLElement: Element, devicePixelRatio: 1,
    localStorage: { getItem: () => null } };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hud = createHUD({ settings: {}, jump() {}, changed() {} });
  const stats = { failed: 1, failure: "区域 (0, 0) 加载失败：不支持数字 ID 格式", pending: 0, nearPending: 0, loaded: 0, wanted: 1 };
  const notice = document.getElementById("notice"), loading = document.getElementById("loading");
  hud.error(stats.failure);
  hud.loading(stats);
  t.mock.timers.tick(6000);
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, stats.failure);
  assert.match(loading.textContent, /1 个区域加载失败，存档显示不完整/);
  assert.equal(loading.classes.has("faded"), false);
  hud.loading({ ...stats, pending: 2 });
  assert.match(loading.textContent, /其余区域仍在加载/);
  hud.loading({ ...stats, failed: 0, failure: undefined, loaded: 1 });
  assert.equal(notice.hidden, true);
  assert.equal(loading.textContent, "已加载");
  t.mock.timers.tick(1500);
  assert.equal(loading.classes.has("faded"), true);
  hud.loading(stats);
  hud.world({ loaded: false });
  assert.equal(notice.hidden, true);
  assert.equal(loading.textContent, "");
});
