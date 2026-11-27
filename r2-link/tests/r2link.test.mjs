import test from "node:test";
import assert from "node:assert/strict";
import { r2linkSource, encodeMessage, decodeMessage } from "../src/index.ts";

/** 记录发送的消息，测试代替数据源回复。 */
class FakeSocket {
  static all = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data) {
    this.sent.push(decodeMessage(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ reason: "" });
  }
  // 以下由测试调用，模拟数据源一侧。
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  reply(header, tail) {
    this.onmessage?.({ data: encodeMessage(header, tail) });
  }
  drop(reason = "") {
    this.readyState = 3;
    this.onclose?.({ reason });
  }
}

const sinkLog = () => {
  const log = [];
  return {
    log,
    sink: {
      region: (x, z, data) => log.push(["region", x, z, data && new Uint32Array(data)[0]]),
      objects: (x, z, d) => log.push(["objects", x, z, d.length]),
      error: (x, z, e) => log.push(["error", x, z, e.message]),
    },
  };
};
const want = (add = [], remove = [], objects = { add: [], remove: [] }) => ({
  center: [0, 0],
  regions: { add, remove },
  objects,
});

test("握手、订阅、提交与重连", async () => {
  FakeSocket.all = [];
  const states = [];
  const scenes = [];
  const source = r2linkSource("ws://test/r2link", {
    WebSocket: FakeSocket,
    retry: 1,
    onState: (s, m) => states.push([s, m]),
    onScene: (s) => scenes.push(s.name),
  });
  const socket = FakeSocket.all[0];
  socket.open();
  assert.deepEqual(socket.sent[0].header, { type: "hello", protocol: "r2link", version: 3 });
  const { log, sink } = sinkLog();
  source.open(sink);
  // 握手前的订阅先记下，握手后作为完整快照发出，近的在前。
  source.want(want([{ x: 3, z: 0 }, { x: 0, z: 0 }]));
  assert.equal(socket.sent.length, 1);
  socket.reply({ type: "welcome", protocol: "r2link", version: 3, scene: { name: "世界" }, camera: { position: [1, 2, 3] } });
  const welcome = await source.welcome;
  assert.equal(welcome.scene.name, "世界");
  assert.deepEqual(welcome.camera.position, [1, 2, 3]);
  assert.equal(source.state, "connected");
  assert.deepEqual(socket.sent[1].header.regions.add, [{ x: 0, z: 0 }, { x: 3, z: 0 }]);

  // 握手后的订阅原样转发。
  source.want(want([{ x: 1, z: 1 }], [{ x: 3, z: 0 }]));
  assert.deepEqual(socket.sent[2].header.regions, { add: [{ x: 1, z: 1 }], remove: [{ x: 3, z: 0 }] });

  const region = new Uint32Array([0x34504c54, 0]).buffer;
  socket.reply({ type: "region", x: 0, z: 0, clippedSections: 3 }, region);
  socket.reply({ type: "region", x: 1, z: 1 });
  socket.reply({ type: "region", x: 3, z: 0 }, region); // 已不需要，忽略
  socket.reply({ type: "failed", x: 1, z: 1, message: "坏了" });
  assert.deepEqual(log, [
    ["region", 0, 0, 0x34504c54],
    ["region", 1, 1, null],
    ["error", 1, 1, "坏了"],
  ]);
  assert.equal(source.clippedSections, 3);

  const chunks = source.chunks();
  assert.equal(socket.sent.at(-1).header.type, "chunks");
  socket.reply({ type: "chunks" }, new Uint8Array(136).buffer);
  assert.equal((await chunks).byteLength, 136);

  // 断线：保留内容，重连后重新握手并发送完整订阅。
  socket.drop("服务器重启");
  assert.deepEqual(states.at(-1), ["reconnecting", "服务器重启"]);
  await new Promise((r) => setTimeout(r, 10));
  const again = FakeSocket.all[1];
  again.open();
  again.reply({ type: "welcome", protocol: "r2link", version: 3, scene: { name: "新世界" } });
  assert.equal(source.state, "connected");
  assert.deepEqual(scenes, ["新世界"]);
  assert.deepEqual(
    again.sent[1].header.regions.add.map(({ x, z }) => [x, z]),
    [[0, 0], [1, 1]],
  );
  source.close();
  assert.equal(source.state, "closed");
  assert.equal(again.readyState, 3);
});

test("首次连接失败时拒绝 welcome 且不重连", async () => {
  FakeSocket.all = [];
  const source = r2linkSource("ws://test/r2link", { WebSocket: FakeSocket, retry: 1 });
  const socket = FakeSocket.all[0];
  socket.open();
  socket.reply({ type: "error", message: "需要 R2Link v3 的 hello" });
  socket.drop();
  await assert.rejects(source.welcome, /需要 R2Link v3/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeSocket.all.length, 1);
  assert.equal(source.state, "closed");
});

test("连不上时报告地址", async () => {
  FakeSocket.all = [];
  const source = r2linkSource("ws://test/r2link", { WebSocket: FakeSocket });
  FakeSocket.all[0].drop();
  await assert.rejects(source.welcome, /无法连接 ws:\/\/test\/r2link/);
});

test("版本不符的 welcome 断开连接", async () => {
  FakeSocket.all = [];
  const source = r2linkSource("ws://test/r2link", { WebSocket: FakeSocket });
  const socket = FakeSocket.all[0];
  socket.open();
  socket.reply({ type: "welcome", protocol: "r2link", version: 2, scene: { name: "旧" } });
  await assert.rejects(source.welcome, /v2，需要 v3/);
});

test("近景完整 SNBT 只交给仍在等待同一范围的订阅者", async () => {
  const source = r2linkSource("ws://test/r2link", { WebSocket: FakeSocket });
  const socket = FakeSocket.all.at(-1);
  socket.open();
  socket.reply({ type:"welcome",protocol:"r2link",version:3,scene:{name:"测试"} });
  await source.welcome;
  const log = [];
  source.open({ ...sinkLog().sink, blockEntities:(x,z,entries) => log.push(entries) });
  const range = { x:0,z:0,center:[1,2,3],radius:2 };
  source.want(want([],[],{add:[range],remove:[]}));
  assert.deepEqual(socket.sent.at(-1).header.blockEntities.add,[range]);
  const entries = [{ position:[16,32,48],snbt:"{id:'unknown'}" }];
  socket.reply({ type:"blockEntities",...range,center:[1,1,3],entries });
  socket.reply({ type:"blockEntities",...range,entries });
  socket.reply({ type:"blockEntities",...range,entries:[] });
  source.want(want([],[],{add:[],remove:[range]}));
  socket.reply({ type:"blockEntities",...range,entries });
  assert.deepEqual(log,[entries,[]]);
  source.close();
});
