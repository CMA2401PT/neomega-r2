import test from "node:test";
import assert from "node:assert/strict";
import { createRenderer } from "../web/render/renderer.js";

// GPU 进程退出时，完成查询可能为真，链接状态和日志则返回 null。
// 模拟真实 API 的返回组合，确保错误不会退化成“编译失败：null”。
for (const stage of ["before-completion", "during-completion", "during-link", "no-extension", "missing-log"]) {
  test(`启动诊断：${stage}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({ text: async () => "#version 300 es\nvoid main(){}" }));
    let lost = stage === "before-completion" || stage === "no-extension";
    const gl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3,
      createProgram: () => ({}), createShader: () => ({}),
      shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
      deleteShader() {}, deleteProgram() {},
      getExtension: () => stage === "no-extension" ? null : { COMPLETION_STATUS_KHR: 4 },
      isContextLost: () => lost,
      getProgramParameter(program, parameter) {
        if ((parameter === 4 && stage === "during-completion") ||
            (parameter === 3 && stage === "during-link")) lost = true;
        return parameter === 4 ? true : null;
      },
      getShaderInfoLog: () => null,
      getProgramInfoLog: () => null,
    };
    await assert.rejects(
      createRenderer({ getContext: () => gl }),
      stage === "missing-log" ? /浏览器未提供编译日志/ : /WebGL 上下文丢失/,
    );
  });
}
