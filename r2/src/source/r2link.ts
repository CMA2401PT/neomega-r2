// R2Link 数据源：浏览器连接数据源的 WebSocket，把会话的订阅转成 want 消息，把收到的区域与对象交给会话。
// 协议见 neomega-r2link 的 README。
import type { DataSource, ObjectWant, RegionCoord, WantChange, WorldSink } from "../session/session.ts";
import type { ObjectDescriptor } from "../contracts.ts";

export const R2LINK_VERSION = 2;

export interface R2LinkScene {
  name: string;
}

/** 相机位置（方块坐标）与朝向（弧度）；朝向省略时保留当前朝向。 */
export interface R2LinkCamera {
  position: number[];
  yaw?: number;
  pitch?: number;
}

export interface R2LinkWelcome {
  scene: R2LinkScene;
  camera?: R2LinkCamera;
}

/** connecting：首次连接；connected：已握手；reconnecting：断线后等待重连，画面保留；closed：已关闭。 */
export type R2LinkState = "connecting" | "connected" | "reconnecting" | "closed";

export interface R2LinkOptions {
  /** 连接断开后多久重连，毫秒，默认 3000；0 表示不重连。首次连接失败不重连。 */
  retry?: number;
  /** 数据源要求移动相机。 */
  onCamera?: (camera: R2LinkCamera) => void;
  /** 数据源更新了世界描述，重连握手时也会调用。 */
  onScene?: (scene: R2LinkScene) => void;
  /** 连接状态变化；message 是断开原因。 */
  onState?: (state: R2LinkState, message?: string) => void;
  /** 测试时替换 WebSocket 实现。 */
  WebSocket?: new (url: string) => WebSocket;
}

export interface R2LinkSource extends DataSource {
  readonly url: string;
  readonly state: R2LinkState;
  /** 首次握手；连接失败或数据源拒绝时拒绝。 */
  readonly welcome: Promise<R2LinkWelcome>;
  /** 数据源报告的、因超出可显示高度而省略的 section 数（按已收到的区域）。 */
  readonly clippedSections: number;
  /** 请求区块占用表，编码同 neomega-r2link 的 ChunkIndex；数据源不提供时为空。 */
  chunks(): Promise<ArrayBuffer>;
}

const encoder = new TextEncoder(),
  decoder = new TextDecoder();

/** 一条消息：uint32LE(JSON 字节数) + JSON + 尾部。 */
export function encodeMessage(header: object, tail?: ArrayBuffer): ArrayBuffer {
  const text = encoder.encode(JSON.stringify(header)),
    data = new Uint8Array(4 + text.length + (tail?.byteLength ?? 0));
  new DataView(data.buffer).setUint32(0, text.length, true);
  data.set(text, 4);
  if (tail) data.set(new Uint8Array(tail), 4 + text.length);
  return data.buffer;
}

export function decodeMessage(data: ArrayBuffer): { header: any; tail: ArrayBuffer } {
  if (data.byteLength < 4) throw Error("R2Link 消息缺少头长度");
  const size = new DataView(data).getUint32(0, true);
  if (size > data.byteLength - 4) throw Error("R2Link JSON 长度超出消息");
  const header = JSON.parse(decoder.decode(new Uint8Array(data, 4, size)));
  if (typeof header?.type !== "string") throw Error("R2Link 消息缺少 type");
  return { header, tail: data.slice(4 + size) };
}

/** 连接 ws:// 或 wss:// 地址的数据源。创建时开始连接；交给 WorldSession 后按会话的需要订阅。
 * 断线时保留已显示的内容，按 retry 间隔重连；重连握手后重新发送完整的订阅，数据源重发全部内容。 */
export function r2linkSource(url: string, options: R2LinkOptions = {}): R2LinkSource {
  const retry = options.retry ?? 3000,
    Socket = options.WebSocket ?? WebSocket,
    key = (x: number, z: number) => `${x}/${z}`;
  let sink: WorldSink | null = null,
    socket: WebSocket | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    state: R2LinkState = "connecting",
    welcomed = false,
    center = [0, 0],
    resolveWelcome!: (value: R2LinkWelcome) => void,
    rejectWelcome!: (error: Error) => void;
  const regions = new Map<string, RegionCoord>(),
    objects = new Map<string, ObjectWant>(),
    clipped = new Map<string, number>(),
    chunkRequests: Array<{ resolve: (data: ArrayBuffer) => void; reject: (error: Error) => void }> = [];
  const welcome = new Promise<R2LinkWelcome>((resolve, reject) => ((resolveWelcome = resolve), (rejectWelcome = reject)));
  welcome.catch(() => {});

  const setState = (next: R2LinkState, message?: string) => {
    state = next;
    options.onState?.(next, message);
  };
  const send = (header: object) => {
    if (welcomed && socket?.readyState === 1) socket.send(encodeMessage(header));
  };
  /** 握手后把当前需要的一切作为新增发出，离中心近的在前。 */
  const sendSnapshot = () => {
    const distance = ({ x, z }: RegionCoord) => Math.hypot(x * 128 + 64 - center[0], z * 128 + 64 - center[1]);
    send({
      type: "want",
      center,
      regions: { add: [...regions.values()].sort((a, b) => distance(a) - distance(b)), remove: [] },
      objects: { add: [...objects.values()], remove: [] },
    });
  };

  function connect() {
    const current = new Socket(url);
    socket = current;
    current.binaryType = "arraybuffer";
    let reason = "",
      opened = false;
    current.onopen = () => {
      opened = true;
      current.send(encodeMessage({ type: "hello", protocol: "r2link", version: R2LINK_VERSION }));
    };
    current.onmessage = (event: MessageEvent) => {
      if (socket !== current) return;
      try {
        receive(decodeMessage(event.data as ArrayBuffer));
      } catch (error) {
        reason = String(error);
        current.close();
      }
    };
    const receive = ({ header, tail }: { header: any; tail: ArrayBuffer }) => {
      const { type, x, z } = header;
      if (type === "welcome") {
        if (header.protocol !== "r2link" || header.version !== R2LINK_VERSION)
          throw Error(`数据源使用 R2Link v${header.version}，需要 v${R2LINK_VERSION}`);
        const first = !welcomed && state === "connecting";
        welcomed = true;
        setState("connected");
        if (first) resolveWelcome({ scene: header.scene, camera: header.camera });
        else options.onScene?.(header.scene);
        sendSnapshot();
      } else if (!welcomed) {
        if (type === "error") reason = header.message;
      } else if (type === "region") {
        if (!regions.has(key(x, z))) return;
        clipped.set(key(x, z), header.clippedSections || 0);
        sink?.region(x, z, tail.byteLength ? tail : null);
      } else if (type === "objects") {
        if (objects.has(key(x, z))) sink?.objects(x, z, header.descriptors as ObjectDescriptor[]);
      } else if (type === "failed") {
        sink?.error(x, z, Error(header.message));
      } else if (type === "chunks") {
        const request = chunkRequests.shift();
        if (header.message) request?.reject(Error(header.message));
        else request?.resolve(tail);
      } else if (type === "camera") {
        options.onCamera?.(header.camera);
      } else if (type === "scene") {
        options.onScene?.(header.scene);
      } else if (type === "error") {
        reason = header.message;
      }
    };
    current.onclose = (event: CloseEvent) => {
      if (socket !== current) return;
      socket = null;
      const message = reason || event.reason || (opened ? "连接已断开" : `无法连接 ${url}`);
      const wasWelcomed = welcomed;
      welcomed = false;
      for (const request of chunkRequests.splice(0)) request.reject(Error(message));
      if (state === "closed") return;
      if (state === "connecting" && !wasWelcomed) {
        setState("closed", message);
        rejectWelcome(Error(message));
        return;
      }
      if (!retry) return setState("closed", message);
      setState("reconnecting", message);
      timer = setTimeout(connect, retry);
    };
  }
  connect();

  return {
    url,
    get state() {
      return state;
    },
    welcome,
    get clippedSections() {
      let count = 0;
      for (const [k, n] of clipped) if (regions.has(k)) count += n;
      return count;
    },
    open(next) {
      sink = next;
    },
    want(change: WantChange) {
      center = change.center;
      for (const { x, z } of change.regions.remove) regions.delete(key(x, z)), clipped.delete(key(x, z));
      for (const value of change.regions.add) regions.set(key(value.x, value.z), value);
      for (const { x, z } of change.objects.remove) objects.delete(key(x, z));
      for (const value of change.objects.add) objects.set(key(value.x, value.z), value);
      send({ type: "want", ...change });
    },
    chunks() {
      if (!welcomed || socket?.readyState !== 1) return Promise.reject(Error("数据源没有连接"));
      return new Promise((resolve, reject) => {
        chunkRequests.push({ resolve, reject });
        send({ type: "chunks" });
      });
    },
    close() {
      if (state !== "closed") setState("closed");
      clearTimeout(timer);
      sink = null;
      const current = socket;
      socket = null;
      current?.close();
      rejectWelcome(Error("连接已关闭"));
    },
  };
}
