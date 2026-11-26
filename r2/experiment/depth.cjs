// 用真实浏览器检查两个后端写给宿主的深度。先运行 npm run demo，再运行本脚本。
const assert = require("node:assert/strict");
const { launch, base } = require("./launch.cjs");

(async () => {
  const browser = await launch();
  try {
    for (const useWebGPU of [false, true]) {
      const page = await browser.newPage();
      // 在演示服务的同源空白页上创建独立渲染器，避免演示页的帧循环参与测试。
      const url = new URL("/depth-check", base).href;
      await page.route(url, route => route.fulfill({ contentType: "text/html", body: "<canvas></canvas>" }));
      await page.goto(url);
      const result = await page.evaluate(async (useWebGPU) => {
        const { createRenderer, MemoryWorld, memorySource, WorldSession, ObjectRegistry } =
          await import("/r2/r2-core.js");
        const r = await createRenderer(document.createElement("canvas"), {
          assets: "/assets/", depthOutput: true, tier: "basic", useWebGPU,
        });
        const camera = { position: [8, 12, 8], yaw: 0, pitch: -Math.PI / 2 };
        const options = { width: 9, height: 5, synchronize: true, tier: "basic" };
        // 读回同一张供 UI 采样的纹理。将两个后端的结果都排成从上到下的顺序。
        async function depths() {
          const { texture, width, height } = r.depth;
          if (r.backend === "webgpu") {
            const buffer = r.device.createBuffer({
              size: 256 * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            const enc = r.device.createCommandEncoder();
            enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [width, height]);
            r.device.queue.submit([enc.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(buffer.getMappedRange());
            const rows = Array.from({ length: height }, (_, y) => [...values.slice(y * 64, y * 64 + width)]);
            buffer.destroy();
            return rows.flat();
          }
          const gl = r.gl, fb = gl.createFramebuffer();
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          const values = new Float32Array(width * height);
          gl.readPixels(0, 0, width, height, gl.RED, gl.FLOAT, values);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          gl.deleteFramebuffer(fb);
          return Array.from({ length: height }, (_, y) => [...values.slice((height-1-y)*width, (height-y)*width)]).flat();
        }
        const before = r.depth;
        await r.draw(camera, options);
        const sky = await depths();
        await r.draw(camera, { ...options, ocean: 5 });
        const water = await depths();
        await r.draw(camera, { ...options, ocean: 5, debug: 3 });
        const waterColor = [...(await r.pixels()).slice(0, 3)];
        const world = new MemoryWorld();
        // 从正上方看，画面上半部是高台，下半部是低台，中心前方还有一块玻璃。
        world.fill([0, 2, 0], [15, 2, 15], "minecraft:stone");
        world.fill([0, 4, 0], [15, 4, 7], "minecraft:stone");
        world.set(8, 6, 8, "minecraft:glass");
        world.set(6, 6, 8, 'minecraft:quartz_stairs ["facing"="east","half"="bottom","shape"="straight"]');
        const session = new WorldSession(r, memorySource(world), { registry: new ObjectRegistry() });
        session.focus(camera.position, { nearRadius: 1, farRadius: 1 });
        const deadline = performance.now() + 15000;
        while (session.stats.pending) {
          if (performance.now() > deadline) throw Error("测试世界加载超时");
          session.publish();
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const view = { ...camera, position: [8.5, 12, 8.5], ortho: 5 };
        const samples = {};
        const stairDepths = {};
        for (const tier of ["voxel", "basic", "shading"]) {
          await r.compile(tier);
          await r.draw(view, { ...options, tier, debug: 3 });
          const values = await depths();
          samples[tier] = [values[4], values[22], values[40]];
          stairDepths[tier] = values[20];
        }
        const preview = await depths();
        // 原生纹理已按从上到下排列；公开的两个像素读回接口都约定从底行起始。
        const [rgba, depthPixels] = await Promise.all([r.pixels(), r.depthPixels()]);
        const expected = Array.from({ length: options.height }, (_, y) => {
          const row = options.height - 1 - y;
          return preview.slice(row * options.width, (row + 1) * options.width);
        }).flat();
        const readbackMatches = rgba.length === expected.length * 4 &&
          depthPixels.length === expected.length && depthPixels.every((d, i) => d === expected[i]);
        await r.compile("accumulation");
        await r.draw(view, { ...options, accumulate: true });
        const still = await depths();
        await r.draw(view, { ...options, width: 3, height: 1 });
        const resized = [r.depth.width, r.depth.height];
        const error = r.gl?.getError() ?? 0;
        session.dispose();
        r.dispose();
        return { before, sky, water, waterColor, samples, stairDepths, preview, still, resized, error, readbackMatches };
      }, useWebGPU);
      assert.equal(result.before, null);
      assert(result.readbackMatches);
      assert(result.sky.every(d => d === -1));
      assert(result.water.every(d => Math.abs(d - 7) < 0.001));
      [110, 209, 112].forEach((expected, i) => assert(Math.abs(result.waterColor[i] - expected) <= 1));
      assert(result.stairDepths.basic >= 5 && result.stairDepths.basic <= 5.501);
      assert.equal(result.stairDepths.shading, result.stairDepths.basic);
      for (const depths of Object.values(result.samples)) {
        [7, 5, 9].forEach((expected, i) => assert(Math.abs(depths[i] - expected) < 0.001, String(depths)));
      }
      assert.deepEqual(result.still, result.preview);
      assert.deepEqual(result.resized, [3, 1]);
      assert.equal(result.error, 0);
      console.log(useWebGPU ? "WebGPU 深度通过" : "WebGL 深度通过");
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
