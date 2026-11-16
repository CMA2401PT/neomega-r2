// 同相机比较采样数，并用 单像素读回的完成时间交叉检查异步 GPU 查询。
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright",
);
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const out = process.env.R2_OUTPUT || "/tmp/r2-quality";
fs.mkdirSync(out, { recursive: true });
const quantile = (a, q) =>
  [...a].sort((a, b) => a - b)[Math.floor((a.length - 1) * q)];
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=metal"],
  });
  const results = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (e) => {
      throw e;
    });
    await page.goto(
      (process.env.R2_URL || "http://127.0.0.1:2413") + "/?scene=world",
    );
    await page.waitForFunction(
      () => globalThis.r2?.state.times.length >= 30,
      null,
      { timeout: 180000 },
    );
    for (const view of [
      { name: "aerial", eye: [1280, 271, 1280], target: [1120, 185, 1080] },
      { name: "architecture", eye: [1180, 85, 1160], target: [1110, 72, 1090] },
    ]) {
      if (view.name !== "aerial")
        await page.evaluate((eye) => r2.loadWorld(eye), view.eye);
      await page.evaluate((v) => {
        r2.setCamera(v.eye, v.target);
        r2.synchronize = true;
      }, view);
      for (const [width, height, samples] of [
        [1920, 1080, 1],
        [2560, 1440, 1],
        [1600, 900, 1],
        [1280, 720, 1],
        [960, 540, 1],
        [640, 360, 1],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => r2.resetTiming());
        await page.waitForFunction(() => r2.state.times.length >= 100, null, {
          timeout: 120000,
        });
        const s = await page.evaluate(() => ({
          gpu: r2.state.times.slice(30),
          completed: r2.state.completedTimes.slice(30),
          frames: r2.state.frameTimes.slice(30),
          error: r2.gl.getError(),
        }));
        assert.equal(s.error, 0);
        const row = {
          view: view.name,
          width,
          height,
          samples,
          gpuMedian: quantile(s.gpu, 0.5),
          gpuP95: quantile(s.gpu, 0.95),
          completedMedian: quantile(s.completed, 0.5),
          completedP95: quantile(s.completed, 0.95),
          frameP95: quantile(s.frames, 0.95),
          ...s,
        };
        results.push(row);
        console.log(
          JSON.stringify({
            ...row,
            gpu: undefined,
            completed: undefined,
            frames: undefined,
          }),
        );
        if (width === 1920) {
          await page
            .locator("aside")
            .evaluate((e) => (e.style.visibility = "hidden"));
          await page.screenshot({ path: `${out}/${view.name}-${samples}.png` });
          await page
            .locator("aside")
            .evaluate((e) => (e.style.visibility = "visible"));
        }
        fs.writeFileSync(
          out + "/results.json",
          JSON.stringify(results, null, 2),
        );
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      r2.synchronize = false;
      const start = performance.now();
      r2.resetTiming();
      function move(now) {
        const t = (now - start) / 1000;
        r2.setCamera(
          [1180 + Math.sin(t) * 4, 85, 1160],
          [1110 + Math.sin(t) * 8, 72, 1090],
          false,
        );
        if (t < 10) requestAnimationFrame(move);
        else window.motionDone = true;
      }
      requestAnimationFrame(move);
    });
    await page.waitForFunction(() => window.motionDone, null, {
      timeout: 30000,
    });
    const motion = await page.evaluate(() => ({
      times: r2.state.times,
      frames: r2.state.frameTimes,
    }));
    fs.writeFileSync(out + "/motion.json", JSON.stringify(motion, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
