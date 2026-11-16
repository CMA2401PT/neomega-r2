// 在同一真实浏览器后端比较指定提交与工作区的预览像素；需独立测试服务。
// PLAYWRIGHT_MODULE、CHROME、R2_URL、R2_WORLD、R2_OUTPUT 可覆盖本机环境。
// 例：node experiment/locate-compare.cjs efffe73
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const reference = process.argv[2] || "efffe73";
const base = process.env.R2_URL || "http://127.0.0.1:2421";
const output = path.resolve(process.env.R2_OUTPUT || "locate-comparison.json");
const sources = {
  before: execFileSync("git", ["show", `${reference}:web/render/ray.frag`], {
    cwd: root, encoding: "utf8",
  }),
  after: fs.readFileSync(path.join(root, "web/render/ray.frag"), "utf8"),
};

(async () => {
  const server = await chromium.launchServer({
    executablePath: process.env.CHROME,
    headless: true,
    args: [`--use-angle=${process.env.R2_ANGLE || "gl"}`],
  });
  const result = { reference, cases: {}, errors: [] };
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    for (const [label, source] of Object.entries(sources)) {
      const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
      const page = await context.newPage();
      page.on("pageerror", (error) => result.errors.push(String(error)));
      await page.route("**/r2/render/ray.frag", (route) => route.fulfill({
        body: source, contentType: "text/plain",
      }));
      // 此服务只用于验收；重置默认场景使两次输入相同。
      await page.request.post(`${base}/api/world/close`);
      await page.goto(base);
      await page.waitForFunction(() => globalThis.viewerR2, null, { timeout: 60000 });
      result.gpu = await page.evaluate(() => {
        const gl = viewerR2.renderer.gl;
        return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
      });
      await page.evaluate(() => {
        globalThis.compareDraw = viewerR2.renderer.draw.bind(viewerR2.renderer);
        viewerR2.renderer.draw = () => {};
      });
      const scenes = process.env.R2_WORLD ? ["mobius", "world"] : ["mobius"];
      const rows = [];
      for (const scene of scenes) {
        if (scene === "world") {
          await page.evaluate((file) => viewerR2.openWorld(file), process.env.R2_WORLD);
        }
        await page.waitForFunction(() => {
          const s = viewerR2.state.stream;
          return s && s.loaded === s.wanted && !s.pending && !s.nearPending && !s.failed;
        }, null, { timeout: 60000 });
        for (const hierarchy of [false, true]) {
          for (const fragments of [false, true]) {
            const pixels = await page.evaluate(({ hierarchy, fragments }) => {
              const { camera, world } = viewerR2.state;
              compareDraw(camera, {
                width: 320, height: 180, time: 0, accumulate: false,
                hierarchy, fragments, shadows: true,
                sun: [0.45, 0.62, 0.3], fog: 512,
                ...(world.scene ? { ocean: world.scene.ocean } : {}),
              });
              if (viewerR2.state.error !== 0) throw Error("WebGL error during comparison");
              return [...viewerR2.renderer.pixels()];
            }, { hierarchy, fragments });
            rows.push({ scene, hierarchy, fragments,
              sha256: crypto.createHash("sha256").update(Buffer.from(pixels)).digest("hex") });
          }
        }
      }
      result.cases[label] = rows;
      await context.close();
    }
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.cases.after, result.cases.before);
    result.matched = true;
    console.log(`Matched ${result.cases.after.length} pixel comparisons on ${result.gpu}`);
  } finally {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    await server.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
