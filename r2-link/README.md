# neOmega R2Link 客户端 (`neomega-r2-link`)

`r2-link` 是 R2 浏览器端通过 WebSocket 连接远端世界数据源的客户端实现，与 Go 端的 [go-link](../go-link/README.md) 配套，使用核心区域和 [r2-mc](../r2-mc/README.md) 近景快照的数据契约，零运行时第三方依赖。

## 用法

```js
import { createRenderer } from "./r2-core.js";
import { createMinecraftWorld, defaultMinecraftAssets } from "./r2-mc.js";
import { r2linkSource } from "./r2-link.js";

const renderer = await createRenderer({ assets: "./assets/" });
const source = r2linkSource("ws://127.0.0.1:2414/r2link", {
  onCamera: (camera) => { /* 更新相机 */ },
});
const { scene, camera } = await source.welcome;
const { session, pick } = createMinecraftWorld(renderer, source, { assets: defaultMinecraftAssets });
```

- 断线后保留已显示内容并按 `retry` 间隔（默认 3000 ms）自动重连，重连握手后重发完整订阅；首次连接失败不重试。
- `source.chunks()` 可向数据源请求 32×32 区块占用表（编码见 [go-link/README.md#占用表](../go-link/README.md#占用表)）。

## 构建与测试

```sh
npm -w r2-link run build
npm -w r2-link run check
npm -w r2-link test
```
