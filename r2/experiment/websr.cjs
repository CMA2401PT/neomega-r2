// 启动 npm run demo 后运行本文件，用真实 GPU 检查超分次数、内部尺寸和最终 PNG 尺寸。
const assert = require("node:assert/strict");
const { launch, base } = require("./launch.cjs");

(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    // 与演示服务同源的空页面，只有本测试的渲染器会提交命令。
    await page.route("**/websr-test", route => route.fulfill({ contentType: "text/html", body: "<canvas></canvas>" }));
    await page.goto(new URL("/websr-test", base).href);
    const result = await page.evaluate(async () => {
      const api = await import("/r2/r2-core.js");
      const archive = await (await fetch("/r2/default-materials.zip")).arrayBuffer();
      const canvas = document.querySelector("canvas");
      const renderer = await api.createRenderer(canvas, {
        tier: "basic", readResource: api.openMaterialPack(new Uint8Array(archive)),
      });
      const world = new api.MemoryWorld();
      world.fill([0, 0, 0], [31, 1, 31], "minecraft:stone");
      const session = new api.WorldSession(renderer, api.memorySource(world), { registry: new api.ObjectRegistry() });
      const camera = { position: [16, 8, 32], yaw: 0, pitch: -0.45 };
      session.focus(camera.position, { nearRadius: 1, farRadius: 1 });
      while (!session.stats.sections) {
        session.publish();
        await new Promise(requestAnimationFrame);
      }

      let passes = 0;
      const begin = GPUCommandEncoder.prototype.beginComputePass;
      GPUCommandEncoder.prototype.beginComputePass = function (descriptor) {
        if (descriptor?.label?.startsWith("WebSR ")) passes++;
        return begin.call(this, descriptor);
      };
      const original = GPUDevice.prototype.createTexture;
      const filmSizes = [];
      GPUDevice.prototype.createTexture = function (descriptor) {
        if (descriptor.format === "rgba32float") filmSizes.push(descriptor.size);
        return original.call(this, descriptor);
      };
      const dimensions = { width: 257, height: 131 };
      const displaySize = { width: 513, height: 261 };
      const frames = [], photos = [];
      try {
        await renderer.compile("accumulation");
        await renderer.compile("accumulation", "photo");
        renderer.outputSettings.accumulationFilter = "light";
        for (const model of ["cnn-xs", "cnn-s", "off"]) {
          const opts = { ...dimensions, displaySize, superResolution: model, tier: "basic", synchronize: true };
          const start = passes;
          await renderer.draw(camera, opts);
          await renderer.draw(camera, { ...opts, accumulate: true });
          frames.push({ model, passes: passes - start, film: filmSizes[0],
            canvas: [canvas.width, canvas.height], bytes: (await renderer.pixels()).length });
        }
        for (const tier of ["basic", "accumulation"]) {
          const job = renderer.photograph(camera, { ...dimensions, superResolution: "cnn-xs", tier, supersample: 2, saveSuperResolution2x: tier === "accumulation" });
          const initial = passes;
          for (let round = 1; round <= 4; round++) {
            while (job.samples < round) {
              job.step();
              await renderer.device.queue.onSubmittedWorkDone();
            }
          }
          const duringSampling = passes - initial;
          const previewSize = tier === "basic" ? dimensions : displaySize;
          job.present(previewSize);
          job.present(previewSize);
          const preview = [canvas.width, canvas.height];
          const png = await createImageBitmap(await job.png());
          photos.push({ tier, duringSampling, preview, outputs: passes - initial, size: [png.width, png.height] });
          png.close();
          job.dispose();
        }
      } finally {
        GPUCommandEncoder.prototype.beginComputePass = begin;
        GPUDevice.prototype.createTexture = original;
        session.dispose();
        renderer.dispose();
      }
      return { frames, photos };
    });
    for (const frame of result.frames) {
      const off = frame.model === "off";
      assert.deepEqual(frame.film, [257, 131]);
      assert.deepEqual(frame.canvas, off ? [257, 131] : [513, 261]);
      assert.equal(frame.bytes, frame.canvas[0] * frame.canvas[1] * 4);
      assert.equal(frame.passes, off ? 0 : 2);
    }
    for (const photo of result.photos) {
      assert.equal(photo.duringSampling, 0);
      const sameSize = photo.tier === "basic";
      assert.deepEqual(photo.preview, sameSize ? [257, 131] : [513, 261]);
      assert.equal(photo.outputs, 1);
      assert.deepEqual(photo.size, sameSize ? [257, 131] : [514, 262]);
    }
    console.log("通过：两档超分、奇数输出尺寸、预览、静止累积、导出与拍照。");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
