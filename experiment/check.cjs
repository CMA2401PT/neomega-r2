// 固定相机比较分层跳跃与逐格遍历，并检查跨格片段、矩形窗口的离开面和透明介质厚度。
// 先运行 npm run demo；R2_URL 指定其他地址，R2_OUTPUT 指定截图目录。
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { launch, base } = require("./launch.cjs");
const out = process.env.R2_OUTPUT || path.join(os.tmpdir(), "r2-check");
fs.mkdirSync(out, { recursive: true });

/** 等当前场景显示完整，再积累 count 帧 GPU 计时。 */
const settle = (page, count) =>
  page.waitForFunction((count) => r2.state.ready && r2.state.times.length >= count, count, { timeout: 90000 });
const read = (page) => page.evaluate(() => Array.from(r2.pixels()));

(async () => {
  const browser = await launch();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(base);
    await page.waitForFunction(() => globalThis.r2, null, { timeout: 90000 });
    await settle(page, 60);
    for (const name of ["showcase", "fences", "cutouts", "cubes", "spill"]) {
      await page.evaluate(async (name) => {
        // 遍历方式只改变求交策略，比较时保持同一个波面时刻。
        r2.fixedTime = 12;
        document.querySelector("#hierarchy").checked = true;
        document.querySelector("#fragments").checked = true;
        await r2.loadScene(name);
      }, name);
      await settle(page, 90);
      const state = await page.evaluate(() => {
        const s = r2.state;
        return {
          statistics: s.statistics,
          allocated: s.allocated,
          blocks: s.blocks,
          fragments: s.fragmentReferences,
          prepareMS: s.session.prepareMS,
          uploadMS: s.session.uploadMS,
          times: s.times.slice(30),
        };
      });
      const pixels = await read(page);
      let overflows = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] === 255 && pixels[i + 1] === 0 && pixels[i + 2] === 255) overflows++;
      assert.equal(overflows, 0, name + " 出现遍历超限");
      assert.equal(await page.evaluate(() => r2.gl.getError()), 0);
      await page.screenshot({ path: path.join(out, name + ".png") });
      await page.evaluate(() => {
        document.querySelector("#hierarchy").checked = false;
        r2.resetTiming();
      });
      await settle(page, 60);
      const plain = await read(page);
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
        await page.evaluate(() => {
          document.querySelector("#fragments").checked = false;
          r2.resetTiming();
        });
        await settle(page, 10);
        const omitted = await read(page);
        for (let i = 0; i < pixels.length; i += 4)
          if (
            Math.abs(pixels[i] - omitted[i]) +
              Math.abs(pixels[i + 1] - omitted[i + 1]) +
              Math.abs(pixels[i + 2] - omitted[i + 2]) >
            6
          )
            changedFragments++;
        assert(changedFragments > 0, "跨格片段没有出现在画面中");
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
    await page.evaluate(async () => {
      document.querySelector("#hierarchy").checked = true;
      await r2.loadScene("uniform");
    });
    await settle(page, 10);
    const uniformTree = await read(page);
    await page.evaluate(() => {
      document.querySelector("#hierarchy").checked = false;
      r2.resetTiming();
    });
    await settle(page, 10);
    assert.deepEqual(uniformTree, await read(page), "矩形窗口的离开面不一致");
    await page.close();
    const one = await browser.newPage({ viewport: { width: 1, height: 1 }, deviceScaleFactor: 1 });
    one.on("pageerror", (e) => errors.push(String(e)));
    await one.goto(base + "/?scene=glass8");
    await one.waitForFunction(() => globalThis.r2, null, { timeout: 90000 });
    await settle(one, 10);
    const thin = await read(one);
    await one.evaluate(() => r2.loadScene("glass16"));
    await settle(one, 10);
    const thick = await read(one);
    assert.deepEqual(thick, thin, "透明介质随着厚度变色");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ results, glass: { thin, thick }, errors }, null, 2));
    console.log(JSON.stringify({ glass: { thin, thick }, errors }));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
