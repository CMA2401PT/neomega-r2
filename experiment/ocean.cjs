// 在真实 Möbius 应用里验证海面、累积、拍照和拾取；固定水面时刻，让画质比较可重复。
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright",
);
const fs = require("node:fs"), assert = require("node:assert/strict");
const base = process.env.R2_URL || "http://127.0.0.1:2430";
const out = process.env.R2_OUTPUT || "/tmp/r2mobius/astra";
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
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=metal"],
  });
  const result = { errors: [], timing: [], checks: {} };
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (error) => result.errors.push(String(error)));
    page.on("console", (message) => {
      if (/GL_INVALID|WebGL:.*INVALID/.test(message.text())) result.errors.push(message.text());
    });
    await page.goto(base);
    await page.waitForFunction(() => {
      const s = globalThis.viewerR2?.state.stream;
      return s && s.loaded === s.wanted && !s.pending && !s.nearPending;
    });
    assert.equal(await page.evaluate(() => viewerR2.state.world.name), "Möbius");
    // 使用应用已经加载的世界，暂停宿主提交，以免截图或计时混入另一套帧参数。
    result.input = await page.evaluate(() => {
      const r = viewerR2.renderer, camera = viewerR2.state.camera;
      const draw = r.draw;
      r.draw = () => {};
      const angle = ((19 - 6) / 24) * 2 * Math.PI;
      globalThis.oceanTest = {
        r, draw, camera,
        options: {
          width: 1280,
          height: 720,
          ocean: 64,
          time: 12,
          sun: [Math.cos(angle), Math.sin(angle), 0.3],
          fog: 1e9,
        },
      };
      document.querySelectorAll("body>*:not(canvas)").forEach((el) => { el.style.visibility = "hidden"; });
      const extension = r.gl.getExtension("WEBGL_debug_renderer_info");
      return {
        camera,
        options: oceanTest.options,
        gpu: r.gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
      };
    });
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      for (const mode of ["without-ocean", "preview", "accumulated"]) {
        const measured = await page.evaluate(async ({ width, height, mode }) => {
          const { r, draw, camera, options } = oceanTest;
          const settings = { ...options, width, height };
          if (mode === "without-ocean") delete settings.ocean;
          draw(camera, settings);
          r.resetTiming();
          const start = performance.now(), completed = [];
          for (let i = 0; i < 128; i++) {
            const frameStart = performance.now();
            draw(camera, {
              ...settings,
              accumulate: mode === "accumulated",
              synchronize: true,
            });
            completed.push(performance.now() - frameStart);
            await new Promise(requestAnimationFrame);
          }
          return { times: r.times, completed, elapsed: performance.now() - start, error: r.gl.getError() };
        }, { width, height, mode });
        assert.equal(measured.error, 0);
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
        draw(camera, options);
        for (let i = 0; i < 64; i++) {
          draw(camera, { ...options, accumulate: true });
          await new Promise(requestAnimationFrame);
        }
      }, { position, target });
      await page.screenshot({ path: `${out}/${name}.png` });
    }
    result.checks = await page.evaluate(async () => {
      const { r, draw, camera, options } = oceanTest;
      draw(camera, options);
      const before = r.accumulated;
      const pick = r.pick(
        { position: [0, 100, 0], yaw: 0, pitch: -Math.PI / 2 },
        { width: 101, height: 101, x: 50, y: 50 },
      );
      // 环最底部约 y=41；越过 y=64 仍能选到它，说明解析海面未挡住拾取。
      const pickedThroughOcean = pick && pick.position[1] < 64;
      const preserved = r.accumulated === before;
      draw(camera, options);
      const time0 = r.gl.getUniform(r.program, r.uniforms.get("uTime"));
      draw(camera, { ...options, accumulate: true, time: 99 });
      const time1 = r.gl.getUniform(r.program, r.uniforms.get("uTime"));
      draw(camera, { ...options, time: 99 });
      const time2 = r.gl.getUniform(r.program, r.uniforms.get("uTime"));
      return { pickedThroughOcean, preserved, pick, times: [time0, time1, time2], error: r.gl.getError() };
    });
    assert(result.checks.pickedThroughOcean);
    assert(result.checks.preserved);
    assert.deepEqual(result.checks.times, [12, 12, 99]);
    assert.equal(result.checks.error, 0);
    const png = await page.evaluate(async () => {
      const { r, camera, options } = oceanTest;
      const photo = r.photograph(camera, {
        ...options,
        width: 1280,
        height: 720,
        samples: 128,
        bounces: 2,
      });
      while (!photo.step()) await new Promise(requestAnimationFrame);
      const bytes = new Uint8Array(await (await photo.png()).arrayBuffer());
      photo.dispose();
      return Array.from(bytes);
    });
    fs.writeFileSync(`${out}/photograph.png`, Buffer.from(png));
    result.checks.emptyOcean = await page.evaluate(async () => {
      const { r, draw, camera, options } = oceanTest;
      r.clear();
      draw(camera, { ...options, ocean: undefined });
      const sky = r.pixels();
      draw(camera, options);
      const sea = r.pixels();
      const offset = (100 * options.width + 100) * 4;
      return { sky: Array.from(sky.slice(offset, offset + 3)), sea: Array.from(sea.slice(offset, offset + 3)), error: r.gl.getError() };
    });
    assert.notDeepEqual(result.checks.emptyOcean.sky, result.checks.emptyOcean.sea);
    assert.equal(result.checks.emptyOcean.error, 0);
    await page.screenshot({ path: `${out}/empty-ocean.png` });
    assert.deepEqual(result.errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
