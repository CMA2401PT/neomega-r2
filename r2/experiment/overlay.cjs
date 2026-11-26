// 在 npm run demo 的服务上检查公开的 mount 接口。截图包含浏览器最终合成的场景和透明层。
const assert = require("node:assert/strict");
const { launch, base } = require("./launch.cjs");

(async () => {
  const { decode } = await import("fast-png");
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (/GPUValidationError|validation error/i.test(m.text())) errors.push(m.text());
    });
    const url = new URL("/overlay-check", base).href;
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<body style='margin:0'><div id='world' style='height:100vh'></div>",
      }),
    );
    await page.goto(url);
    await page.evaluate(async () => {
      const { mount, MemoryWorld, memorySource } = await import("/r2/r2-frontend.js");
      const world = new MemoryWorld();
      world.fill([-16, 0, -16], [31, 0, 31], "minecraft:stone");
      globalThis.view = await mount(document.querySelector("#world"), {
        source: memorySource(world),
        camera: { position: [8, 4, 8], yaw: 0, pitch: 0 },
        chunks: () => world.chunkIndex(),
      });
    });
    const ui = page.frames()[1];
    await ui.waitForFunction(() => document.querySelector("#startup-status").hidden);
    // 场景以半分辨率求交，叠加层仍使用显示像素。
    await ui.evaluate(() => {
      const resolution = document.querySelector("#resolution");
      resolution.value = "0.5";
      resolution.dispatchEvent(new Event("change"));
    });
    await ui.waitForFunction(() => document.querySelector("#resolution-value").textContent === "320×200");
    const css = await ui.addStyleTag({ content: "body > :not(canvas) {visibility:hidden}" });
    async function snapshot() {
      await ui.evaluate(async () => {
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
      });
      return decode(await page.screenshot());
    }
    function rgb(image, x, y) {
      const offset = image.channels * (image.width * y + x);
      return [...image.data.slice(offset, offset + 3)];
    }
    await page.evaluate(() => {
      globalThis.face = view.overlay.polygon(
        [
          [6, -1, 0],
          [10, -1, 0],
          [10, 3, 0],
          [6, 3, 0],
        ],
        { fill: "#ff00ff" },
      );
    });
    let img = await snapshot();
    assert.deepEqual(rgb(img, 320, 260), [255, 0, 255], "地面前的半块面可见");
    assert.notDeepEqual(rgb(img, 320, 345), [255, 0, 255], "地面遮挡另一半");
    await page.evaluate(() => {
      const art = (globalThis.art = document.createElement("canvas"));
      art.width = 24;
      art.height = 24;
      const ctx = art.getContext("2d");
      ctx.fillStyle = "#00ffff";
      ctx.fillRect(0, 0, 24, 24);
      globalThis.icon = view.overlay.marker([8, 0.3, 0], { image: art, alwaysVisible: true });
    });
    img = await snapshot();
    assert.deepEqual(rgb(img, 320, 345), [0, 255, 255], "置顶画布标记穿过地面");
    await page.evaluate(() => {
      icon.setPosition([8, 3, 0]);
      face.remove();
    });
    img = await snapshot();
    assert.notDeepEqual(rgb(img, 320, 345), [0, 255, 255]);
    assert.deepEqual(rgb(img, 320, 239), [0, 255, 255]);
    await page.evaluate(() => {
      const ctx = art.getContext("2d");
      ctx.fillStyle = "#00ff00";
      ctx.fillRect(0, 0, art.width, art.height);
      icon.refresh();
    });
    img = await snapshot();
    assert.deepEqual(rgb(img, 320, 239), [0, 255, 0]);
    await page.evaluate(() => icon.remove());
    img = await snapshot();
    assert.notDeepEqual(rgb(img, 320, 239), [0, 255, 0], "删除时恢复干净背景");
    // 同一个倾斜面穿过水平石台。正交镜头下每个像素仍需用面在该处的深度。
    await page.evaluate(() => {
      view.moveCamera({ position: [8, 8, 8], yaw: 0, pitch: -Math.PI / 2, ortho: 8 });
      globalThis.slope = view.overlay.polygon(
        [
          [6, 2, 6],
          [10, 0, 6],
          [10, 0, 10],
          [6, 2, 10],
        ],
        { fill: "#ff00ff" },
      );
      globalThis.fixed = view.overlay.marker([8, 2, 8], {
        points: [
          [-10, -6],
          [10, -6],
          [10, 6],
          [-10, 6],
        ],
        fill: "#00ffff",
        alwaysVisible: true,
      });
    });
    img = await snapshot();
    assert.deepEqual(rgb(img, 245, 200), [255, 0, 255]);
    assert.notDeepEqual(rgb(img, 395, 200), [255, 0, 255]);
    assert.deepEqual(rgb(img, 329, 200), [0, 255, 255]);
    await page.evaluate(() => view.moveCamera({ position: [8, 8, 8], ortho: 16 }));
    img = await snapshot();
    assert.notDeepEqual(rgb(img, 245, 200), [255, 0, 255], "镜头拉远后面变小");
    assert.deepEqual(rgb(img, 329, 200), [0, 255, 255], "标记仍保持像素尺寸");
    assert.notDeepEqual(rgb(img, 331, 200), [0, 255, 255]);
    await page.evaluate(() => {
      slope.remove();
      fixed.remove();
      view.moveCamera({ position: [8, 4, 8], yaw: 0, pitch: 0, ortho: undefined });
    });
    await page.evaluate(() => {
      globalThis.line = view.overlay.line(
        [
          [7, 3, 0],
          [9, 3, 0],
        ],
        { stroke: "#ff0000", strokeWidth: 4 },
      );
      globalThis.box = view.overlay.blockOutline([8, 2, 0], { stroke: "#00ff00", strokeWidth: 4 });
    });
    img = await snapshot();
    assert.deepEqual(rgb(img, 300, 239), [255, 0, 0], "世界折线按指定线宽绘制");
    assert.deepEqual(rgb(img, 340, 245), [0, 255, 0], "选框包含靠近相机的顶边");
    await page.evaluate(() => {
      line.remove();
      box.remove();
    });
    await css.evaluate((e) => e.remove());
    await ui.evaluate(() => document.querySelector("#map-open").click());
    await ui.waitForFunction(() => !document.querySelector("#map-overlay").hidden);
    await ui.locator("#map-overlay").click({ position: { x: 340, y: 205 } });
    await ui.waitForFunction(() => !document.querySelector("#map-jump").disabled);
    const selected = await ui.locator("#map-selection").textContent();
    assert.match(selected, /顶面/);
    await ui.evaluate(() => {
      const zoom = document.querySelector("#map-zoom");
      zoom.value = zoom.max;
      zoom.dispatchEvent(new Event("input"));
    });
    img = await snapshot();
    assert.deepEqual(rgb(img, 320, 200), [11, 107, 107], "区块概览保留玩家箭头");
    await ui.locator("#map-overlay").press("Escape");
    await page.evaluate(() => view.dispose());
    assert.deepEqual(errors, []);
    await page.close();
    console.log("WebGPU 标记与地图通过");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
