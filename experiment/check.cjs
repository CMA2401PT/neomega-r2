// 固定相机比较分层跳跃与逐格遍历，并检查裁片和透明介质厚度；不会操作已有 viewer。
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright",
);
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const base = process.env.R2_URL || "http://127.0.0.1:2413";
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=metal"],
  });
  const results = [];
  fs.mkdirSync("/tmp/r2-check", { recursive: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(base);
    await page.waitForFunction(
      () => globalThis.r2?.state.times.length >= 60,
      null,
      { timeout: 90000 },
    );
    for (const name of ["showcase", "fences", "cutouts", "cubes", "spill"]) {
      await page.evaluate(async (name) => {
        document.querySelector("#hierarchy").checked = true;
        document.querySelector("#fragments").checked = true;
        await r2.loadScene(name);
      }, name);
      await page.waitForFunction(() => r2.state.times.length >= 90);
      const state = await page.evaluate(() => {
        const s = r2.state;
        return {
          statistics: s.statistics,
          assetMS: s.assetMS,
          allocated: s.allocated,
          buildMS: s.scene.buildMS,
          uploadMS: s.scene.uploadMS,
          nonAir: s.scene.nonAir,
          fragments: s.scene.fragmentReferences,
          times: s.times.slice(30),
        };
      });
      const pixels = await page.evaluate(() => Array.from(r2.pixels()));
      let overflows = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] === 255 && pixels[i + 1] === 0 && pixels[i + 2] === 255)
          overflows++;
      assert.equal(overflows, 0, name + " 出现遍历超限");
      assert.equal(await page.evaluate(() => r2.gl.getError()), 0);
      await page.screenshot({ path: "/tmp/r2-check/" + name + ".png" });
      await page.evaluate(() => {
        document.querySelector("#hierarchy").checked = false;
        r2.resetTiming();
      });
      await page.waitForFunction(() => r2.state.times.length >= 60);
      const plain = await page.evaluate(() => Array.from(r2.pixels()));
      let differences = 0,
        max = 0;
      for (let i = 0; i < pixels.length; i++) {
        const delta = Math.abs(pixels[i] - plain[i]);
        max = Math.max(max, delta);
        if (delta > 2) differences++;
      }
      assert.equal(differences, 0, name + " 分层改变画面");
      let changedFragments = 0;
      if (name === "spill") {
        await page.evaluate(
          () => (document.querySelector("#fragments").checked = false),
        );
        await page.waitForTimeout(100);
        const omitted = await page.evaluate(() => Array.from(r2.pixels()));
        for (let i = 0; i < pixels.length; i += 4)
          if (
            Math.abs(pixels[i] - omitted[i]) +
              Math.abs(pixels[i + 1] - omitted[i + 1]) +
              Math.abs(pixels[i + 2] - omitted[i + 2]) >
            6
          )
            changedFragments++;
        assert(changedFragments > 0, "预裁切片段没有出现在画面中");
      }
      const sorted = state.times.sort((a, b) => a - b);
      const result = {
        name,
        gpuMedianMS: sorted[Math.floor(sorted.length / 2)],
        gpuP95MS: sorted[Math.floor(sorted.length * 0.95)],
        maxChannelDifference: max,
        changedFragments,
        overflows,
        ...state,
      };
      results.push(result);
      console.log(JSON.stringify({ ...result, times: undefined }));
    }
    // 非立方体尺寸的窗口也要正确离开顶面，不能把补齐后的空间当成真实高度。
    const uniform = await page.evaluate(() => r2.state.scene);
    uniform.grid.parts = [0];
    uniform.camera = [32, 16, 32];
    uniform.target = [32, 40, 32];
    const stone = uniform.names["minecraft:stone []"];
    const uniformCells = Buffer.alloc(64 * 32 * 64 * 8);
    for (let i = 0; i < uniformCells.length; i += 8)
      uniformCells.writeUInt32LE(stone, i);
    await page.route("**/api/scene?name=uniform", (route) =>
      route.fulfill({ json: uniform }),
    );
    await page.route("**/api/cells?name=uniform", (route) =>
      route.fulfill({
        contentType: "application/octet-stream",
        body: uniformCells,
      }),
    );
    await page.evaluate(async () => {
      document.querySelector("#hierarchy").checked = true;
      await r2.loadScene("uniform");
    });
    await page.waitForFunction(() => r2.state.times.length >= 10);
    const uniformTree = await page.evaluate(() => Array.from(r2.pixels()));
    await page.evaluate(() => {
      document.querySelector("#hierarchy").checked = false;
      r2.resetTiming();
    });
    await page.waitForFunction(() => r2.state.times.length >= 10);
    const uniformCellsImage = await page.evaluate(() =>
      Array.from(r2.pixels()),
    );
    assert.deepEqual(uniformTree, uniformCellsImage, "矩形窗口的离开面不一致");
    await page.close();
    const one = await browser.newPage({
      viewport: { width: 1, height: 1 },
      deviceScaleFactor: 1,
    });
    await one.goto(base + "/?scene=glass8");
    await one.waitForFunction(
      () => globalThis.r2?.state.times.length >= 10,
      null,
      { timeout: 90000 },
    );
    const thin = await one.evaluate(() => Array.from(r2.pixels()));
    await one.evaluate(() => r2.loadScene("glass16"));
    await one.waitForFunction(() => r2.state.times.length >= 10);
    const thick = await one.evaluate(() => Array.from(r2.pixels()));
    assert.deepEqual(thick, thin, "透明介质随着厚度变色");
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      "/tmp/r2-check/results.json",
      JSON.stringify({ results, glass: { thin, thick }, errors }, null, 2),
    );
    console.log(JSON.stringify({ glass: { thin, thick }, errors }));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
