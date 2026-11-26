// 在真实 Möbius 应用里验证海面、累积、拍照和拾取；固定水面时刻，让画质比较可重复。
// R2_URL 指向已运行的 neomega-viewer-r2（默认 2412），R2_OUTPUT 指定截图目录。
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const { launch } = require("./launch.cjs");
const base = process.env.R2_URL || "http://127.0.0.1:2412";
const out = process.env.R2_OUTPUT || path.join(os.tmpdir(), "r2-ocean");
fs.mkdirSync(out, { recursive: true });

/** GPU 查询只统计热身后的样本，不把浏览器回调上限当成渲染耗时。
 * @param {number[]} values
 */
function summarize(values) {
  const sorted = values.slice(30).sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

(async () => {
  const browser = await launch();
  const result = { errors: [], timing: [], checks: {} };
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (error) => result.errors.push(String(error)));
    page.on("console", (message) => {
      if (/GPUValidationError|validation error/i.test(message.text())) result.errors.push(message.text());
    });
    await page.goto(base);
    await page.waitForFunction(() => {
      const s = globalThis.viewerR2?.state.stream;
      return s && s.loaded === s.wanted && !s.pending && !s.nearPending;
    });
    assert.equal(await page.evaluate(() => viewerR2.state.world.name), "Möbius");
    // 使用应用已经加载的世界，暂停宿主提交，以免截图或计时混入另一套帧参数。
    result.input = await page.evaluate(async () => {
      const r = viewerR2.renderer, camera = viewerR2.state.camera;
      const draw = r.draw;
      r.draw = () => false;
      await r.frameDone;
      await r.compile("accumulation");
      const angle = ((19 - 6) / 24) * 2 * Math.PI;
      globalThis.oceanTest = {
        r, draw, camera,
        options: {
          width: 1280,
          height: 720,
          synchronize: true,
          ocean: 64,
          time: 12,
          sun: [Math.cos(angle), Math.sin(angle), 0.3],
          fog: 1e9,
        },
      };
      document.querySelectorAll("body>*:not(canvas)").forEach((el) => { el.style.visibility = "hidden"; });
      return {
        camera,
        options: oceanTest.options,
        gpu: r.device.adapterInfo.description,
      };
    });
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      for (const mode of ["without-ocean", "preview", "accumulated"]) {
        const measured = await page.evaluate(async ({ width, height, mode }) => {
          const { r, draw, camera, options } = oceanTest;
          const settings = { ...options, width, height };
          if (mode === "without-ocean") delete settings.ocean;
          await draw(camera, settings);
          r.resetTiming();
          const start = performance.now(), completed = [];
          for (let i = 0; i < 128; i++) {
            const frameStart = performance.now();
            await draw(camera, {
              ...settings,
              accumulate: mode === "accumulated",
              synchronize: true,
            });
            completed.push(performance.now() - frameStart);
            await new Promise(requestAnimationFrame);
          }
          return { times: r.times, completed, elapsed: performance.now() - start };
        }, { width, height, mode });
        const row = { width, height, mode, ...summarize(measured.times), completion: summarize(measured.completed), ...measured };
        result.timing.push(row);
        console.log(JSON.stringify({ ...row, times: undefined, completed: undefined }));
        if (mode !== "without-ocean") await page.screenshot({ path: `${out}/${width}-${mode}.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    for (const [name, position, target] of [
      ["underwater", [-35, 59, 35], [0, 64, 0]],
      ["submerged-ring", [-65, 100, 100], [0, 65, 0]],
      ["outside-window", [-1600, 85, 1600], [0, 64, 0]],
    ]) {
      await page.evaluate(async ({ position, target }) => {
        const { r, draw, options } = oceanTest;
        const d = target.map((v, i) => v - position[i]);
        const camera = { position, yaw: Math.atan2(d[0], -d[2]), pitch: Math.asin(d[1] / Math.hypot(...d)) };
        await draw(camera, options);
        for (let i = 0; i < 64; i++) {
          await draw(camera, { ...options, accumulate: true });
          await new Promise(requestAnimationFrame);
        }
      }, { position, target });
      await page.screenshot({ path: `${out}/${name}.png` });
    }
    result.checks = await page.evaluate(async () => {
      const { r, draw, camera, options } = oceanTest;
      await draw(camera, options);
      const before = r.accumulated;
      const pick = await r.pick(
        { position: [0, 100, 0], yaw: 0, pitch: -Math.PI / 2 },
        { width: 101, height: 101, x: 50, y: 50 },
      );
      // 环最底部约 y=41；越过 y=64 仍能选到它，说明解析海面未挡住拾取。
      const pickedThroughOcean = pick && pick.position[1] < 64;
      const preserved = r.accumulated === before;
      return { pickedThroughOcean, preserved, pick };
    });
    assert(result.checks.pickedThroughOcean);
    assert(result.checks.preserved);
    const png = await page.evaluate(async () => {
      const { r, camera, options } = oceanTest;
      const photo = r.photograph(camera, {
        ...options,
        width: 1280,
        height: 720,
        bounces: 2,
      });
      while (photo.samples < 128) {
        photo.step();
        await new Promise(requestAnimationFrame);
      }
      const bytes = new Uint8Array(await (await photo.png()).arrayBuffer());
      photo.dispose();
      return Array.from(bytes);
    });
    fs.writeFileSync(`${out}/photograph.png`, Buffer.from(png));
    result.checks.emptyOcean = await page.evaluate(async () => {
      const { r, draw, camera, options } = oceanTest;
      r.clear();
      await draw(camera, { ...options, ocean: undefined });
      const sky = await r.pixels();
      await draw(camera, options);
      const sea = await r.pixels();
      const offset = (100 * options.width + 100) * 4;
      return { sky: Array.from(sky.slice(offset, offset + 3)), sea: Array.from(sea.slice(offset, offset + 3)) };
    });
    assert.notDeepEqual(result.checks.emptyOcean.sky, result.checks.emptyOcean.sea);
    await page.screenshot({ path: `${out}/empty-ocean.png` });
    assert.deepEqual(result.errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
