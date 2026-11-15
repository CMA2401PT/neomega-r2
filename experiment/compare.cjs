// 旧版纯 brickmap 与 R2 在相同全窗口中绘制；旧版没有近景复杂模型，属于较严格的成本基准。
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright",
);
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const out = process.env.R2_OUTPUT || "/tmp/r2-compare";
fs.mkdirSync(out, { recursive: true });
const q = (a, p) =>
  [...a].sort((a, b) => a - b)[Math.floor((a.length - 1) * p)];
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=metal"],
  });
  const rows = [];
  try {
    for (const mode of [
      "baseline",
      "r2",
      ...(process.env.R2_ABLATE ? ["r2-flat", "r2-far", "r2-far-flat"] : []),
    ]) {
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
      });
      page.on("pageerror", console.error);
      await page.goto(
        mode === "baseline"
          ? "http://127.0.0.1:2424/"
          : "http://127.0.0.1:2413/?scene=world" +
              (mode.includes("flat") ? "&flat=1" : "") +
              (mode.includes("far") ? "&farOnly=1" : ""),
      );
      await page.waitForFunction(
        () =>
          globalThis.baseline?.state.times.length >= 30 ||
          globalThis.r2?.state.times.length >= 30,
        null,
        { timeout: 180000 },
      );
      for (const view of [
        { name: "aerial", eye: [1280, 271, 1280], target: [1120, 185, 1080] },
        { name: "ground", eye: [1280, 78, 1280], target: [1210, 70, 1200] },
        {
          name: "architecture",
          eye: [1180, 85, 1160],
          target: [1110, 72, 1090],
        },
      ]) {
        await page.evaluate(
          async ({ view, mode }) => {
            const api = mode === "baseline" ? baseline : r2;
            if (view.name !== "aerial")
              await (mode === "baseline"
                ? api.load(view.eye)
                : api.loadWorld(view.eye));
            api.setCamera(view.eye, view.target);
            api.synchronize = true;
          },
          { view, mode },
        );
        for (const [width, height] of [
          [1280, 720],
          [1920, 1080],
          [2560, 1440],
        ]) {
          await page.setViewportSize({ width, height });
          await page.evaluate(
            (mode) =>
              mode === "baseline" ? baseline.reset() : r2.resetTiming(),
            mode,
          );
          await page.waitForFunction(
            (mode) =>
              (mode === "baseline" ? baseline.state.times : r2.state.times)
                .length >= 120,
            mode,
            { timeout: 120000 },
          );
          const data = await page.evaluate((mode) => {
            const s = mode === "baseline" ? baseline.state : r2.state;
            return {
              gpu: s.times.slice(40),
              completed: (s.completed || s.completedTimes).slice(40),
              frames: (s.frames || s.frameTimes).slice(40),
              error: mode === "baseline" ? s.error : r2.gl.getError(),
              stats: s.scene?.stats,
            };
          }, mode);
          assert.equal(data.error, 0);
          const row = {
            mode,
            view: view.name,
            width,
            height,
            gpuMedian: q(data.gpu, 0.5),
            gpuP95: q(data.gpu, 0.95),
            completedMedian: q(data.completed, 0.5),
            completedP95: q(data.completed, 0.95),
            frameMedian: q(data.frames, 0.5),
            frameP95: q(data.frames, 0.95),
            ...data,
          };
          rows.push(row);
          console.log(
            JSON.stringify({
              ...row,
              gpu: undefined,
              completed: undefined,
              frames: undefined,
              stats: undefined,
            }),
          );
          fs.writeFileSync(
            out + "/results.json",
            JSON.stringify(rows, null, 2),
          );
          if (width === 1920) {
            if (mode !== "baseline")
              await page
                .locator("aside")
                .evaluate((e) => (e.style.visibility = "hidden"));
            await page.screenshot({ path: `${out}/${mode}-${view.name}.png` });
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
