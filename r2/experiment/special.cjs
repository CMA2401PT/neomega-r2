// 固定动画时间验证格内动态候选、透明孔洞、方块遮挡，并比较开启与关闭层次的像素。
// 先运行 npm run demo；R2_URL 指定其他地址，R2_OUTPUT 指定结果目录。
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { launch, base } = require("./launch.cjs");
const out = process.env.R2_OUTPUT || path.join(os.tmpdir(), "r2-special-check");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(base + "/?scene=special&backend=webgl");
    await page.waitForFunction(
      () => globalThis.r2?.state.ready && r2.state.times.length >= 30,
      null,
      { timeout: 90000 },
    );
    async function pixels() {
      await page.evaluate(() => r2.resetTiming());
      await page.waitForFunction(() => r2.state.times.length >= 15);
      return Buffer.from(
        await page.evaluate(() => {
          const pixels = r2.pixels();
          let value = "";
          for (let i = 0; i < pixels.length; i += 8192)
            value += String.fromCharCode(...pixels.subarray(i, i + 8192));
          return btoa(value);
        }),
        "base64",
      );
    }
    await page.evaluate(() => {
      r2.fixedTime = 0;
      document.querySelector("aside").style.visibility = "hidden";
    });
    const initial = await pixels();
    await page.screenshot({ path: path.join(out, "special.png") });
    await page.evaluate(
      () => (document.querySelector("#hierarchy").checked = false),
    );
    const plain = await pixels();
    await page.evaluate(() => {
      r2.specialEnabled = false;
      document.querySelector("#hierarchy").checked = true;
    });
    const staticTree = await pixels();
    await page.evaluate(
      () => (document.querySelector("#hierarchy").checked = false),
    );
    const staticPlain = await pixels();
    let staticBoundaryChannels = 0;
    for (let i = 0; i < plain.length; i++) {
      // 先独立识别静态方块共享边上的舍入差异，动态对象不得引入额外差异。
      if (staticPlain[i] !== staticTree[i]) staticBoundaryChannels++;
      assert.equal(
        plain[i] - initial[i],
        staticPlain[i] - staticTree[i],
        "动态部件被空间跳跃遗漏",
      );
    }
    await page.evaluate(() => (r2.specialEnabled = true));
    await page.evaluate(() => {
      document.querySelector("#hierarchy").checked = true;
      r2.fixedTime = 2;
    });
    const moved = await pixels();
    let changed = 0;
    for (let i = 0; i < initial.length; i += 4)
      if (
        initial[i] !== moved[i] ||
        initial[i + 1] !== moved[i + 1] ||
        initial[i + 2] !== moved[i + 2]
      )
        changed++;
    assert(changed > 100, "书页没有运动");
    await page.setViewportSize({ width: 1, height: 1 });
    const probes = [];
    for (const probe of [
      {
        name: "旗面透明孔",
        eye: [35.7, 2.55, 30],
        target: [35.7, 2.55, 26],
        equal: true,
      },
      {
        name: "旗面实色",
        eye: [35.7, 3.2, 30],
        target: [35.7, 3.2, 26],
        equal: false,
      },
      {
        name: "石英遮挡",
        eye: [33.5, 2.5, 31],
        target: [32.5, 3.1, 26.5],
        equal: true,
      },
    ]) {
      await page.evaluate((p) => {
        r2.setCamera(p.eye, p.target);
        r2.specialEnabled = true;
      }, probe);
      const on = await pixels();
      await page.evaluate(() => (r2.specialEnabled = false));
      const off = await pixels();
      if (probe.equal) assert.deepEqual(on, off, probe.name);
      else assert.notDeepEqual(on, off, probe.name);
      probes.push({ ...probe, on, off });
    }
    assert.equal(await page.evaluate(() => r2.gl.getError()), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(
        { changed, staticBoundaryChannels, probes, errors },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ changed, staticBoundaryChannels, probes, errors }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
