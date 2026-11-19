import assert from "node:assert/strict";
import test from "node:test";
import { WorldSession } from "../src/session/session.ts";

// 只替代 Worker 和显存提交，仍通过公开数据源接口驱动真实会话的失败、邻区更新和重试。
test("失败区域退出等待，邻区完成不会掩盖错误，重新提交后恢复", async (t) => {
  const workers = [];
  class TestWorker {
    messages = [];
    constructor() { workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    reply(data) { this.onmessage({ data }); }
    terminate() {}
  }
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker;
  t.after(() => { globalThis.Worker = previous; });
  let sink;
  const wanted = [], errors = [];
  const source = {
    open(value) { sink = value; },
    want(change) { wanted.push(change); },
    close() {},
  };
  const gpu = {
    regions: new Map(), allocator: { used: 0 },
    setWindow() {}, remove(key) { this.regions.delete(key); },
    install(result) { this.regions.set(result.key, result); },
  };
  const renderer = {
    catalog: { models: [] }, states: new Uint32Array(),
    createWorld: () => gpu,
    objects: {
      objects: new Map(), removeRegion: () => false, references: () => [],
      setRegion: async () => false, clear() {},
    },
  };
  const session = new WorldSession(renderer, source, { registry: {}, onError: (message) => errors.push(message) });
  t.after(() => session.dispose());
  session.focus([8, 64, 8], { nearRadius: 2, farRadius: 8 });
  assert.ok(session.stats.nearPending > 0);
  for (const { x, z } of wanted[0].regions.add) sink.error(x, z, Error("不支持数字 ID 格式"));
  assert.equal(session.stats.pending, 0);
  assert.equal(session.stats.nearPending, 0);
  assert.equal(session.stats.failed, wanted[0].regions.add.length);
  assert.match(session.stats.failure, /区域 .*加载失败：不支持数字 ID 格式/);
  assert.match(errors[0], /加载失败/);
  const worker = workers[0];
  sink.region(1, 0, null);
  let put = worker.messages.at(-1);
  worker.reply({ type: "stored", key: put.key, request: put.request });
  assert.equal(session.stats.failed, wanted[0].regions.add.length - 1, "邻区就绪不能清除本区错误");
  assert.equal(session.stats.nearPending, 0);
  sink.region(0, 0, null);
  put = worker.messages.at(-1);
  worker.reply({ type: "stored", key: put.key, request: put.request });
  assert.equal(session.stats.failed, wanted[0].regions.add.length - 2);
  assert.equal(session.stats.nearPending, 1, "本区数据重交后重新等待发布");
  sink.objects(0, 0, []);
  await new Promise((resolve) => setImmediate(resolve));
  const prepare = worker.messages.findLast((message) => message.type === "prepare");
  worker.reply({ type: "prepared", request: prepare.request, result: {
    key: "0/0", stats: { sections: 0, unknown: 0, prepareMS: 0 },
  } });
  session.publish();
  assert.equal(session.stats.nearPending, 0);
  session.focus([8192, 64, 8192], { nearRadius: 2, farRadius: 8 });
  assert.equal(session.stats.failed, 0);
  assert.equal(session.stats.failure, undefined);
});
