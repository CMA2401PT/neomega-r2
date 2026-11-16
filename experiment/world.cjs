// 实际存档窗口与相机固定；测量实际画布尺寸，分别记录 GPU 时间和浏览器帧间隔。
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright",
);
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const output = process.env.R2_OUTPUT || "/tmp/r2-world-benchmark";
fs.mkdirSync(output, { recursive: true });
const views = [
  { name: "aerial", eye: [1280, 271, 1280], target: [1120, 185, 1080] },
  { name: "ground", eye: [1280, 78, 1280], target: [1210, 70, 1200] },
  { name: "architecture", eye: [1180, 85, 1160], target: [1110, 72, 1090] },
];
const sizes = process.env.R2_SURVEY
  ? [[1280, 720]]
  : [
      [960, 540],
      [1280, 720],
      [1600, 900],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ];
const percentile = (a, q) =>
  [...a].sort((a, b) => a - b)[Math.floor((a.length - 1) * q)];
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=metal"],
  });
  const results = { views: [], runs: [], errors: [] };
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (e) => results.errors.push(String(e)));
    await page.goto(
      (process.env.R2_URL || "http://127.0.0.1:2413") + "/?scene=world",
    );
    await page.waitForFunction(
      () => globalThis.r2?.state.times.length > 30,
      null,
      { timeout: 180000 },
    );
    results.renderer = await page.evaluate(() => {
      const ext = r2.gl.getExtension("WEBGL_debug_renderer_info");
      return r2.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    });
    for (const view of views) {
      if (view.name !== "aerial")
        await page.evaluate(async (eye) => {
          await r2.loadWorld(eye);
        }, view.eye);
      await page.evaluate((v) => r2.setCamera(v.eye, v.target), view);
      results.views.push({
        view,
        ...(await page.evaluate(() => ({
          stats: r2.state.scene.stats,
          gpuBytes: r2.state.allocated,
        }))),
      });
      for (const samples of [1])
        for (const [width, height] of sizes) {
          await page.setViewportSize({ width, height });
          await page.evaluate(() => r2.resetTiming());
          await page.waitForFunction(() => r2.state.times.length >= 100, null, {
            timeout: 120000,
          });
          const state = await page.evaluate(() => {
            const s = r2.state;
            return {
              gpu: s.times.slice(30),
              frames: s.frameTimes.slice(30),
              resolution: s.resolution,
              error: r2.gl.getError(),
              pixels: (() => {
                const p = r2.pixels();
                let overflow = 0;
                for (let i = 0; i < p.length; i += 4)
                  if (p[i] === 255 && p[i + 1] === 0 && p[i + 2] === 255)
                    overflow++;
                return overflow;
              })(),
            };
          });
          assert.equal(state.error, 0);
          assert.equal(state.pixels, 0, "遍历超限");
          const row = {
            view: view.name,
            width,
            height,
            samples,
            gpuMedianMS: percentile(state.gpu, 0.5),
            gpuP95MS: percentile(state.gpu, 0.95),
            frameMedianMS: percentile(state.frames, 0.5),
            frameP95MS: percentile(state.frames, 0.95),
            missedFrames: state.frames.filter((v) => v > 20).length,
            frameCount: state.frames.length,
            ...state,
          };
          results.runs.push(row);
          console.log(
            JSON.stringify({ ...row, gpu: undefined, frames: undefined }),
          );
          if ((width === 1920 && samples === 1) || process.env.R2_SURVEY)
            await page.screenshot({
              path: `${output}/${view.name}-${width}-${samples}.png`,
            });
          fs.writeFileSync(
            output + "/results.json",
            JSON.stringify(results, null, 2),
          );
          // 已远超帧预算时不再增加像素；保留失败点而不推测可用分辨率。
          if (row.gpuMedianMS > 45) break;
        }
    }
    assert.deepEqual(results.errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(
      output + "/results.json",
      JSON.stringify(results, null, 2),
    );
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
