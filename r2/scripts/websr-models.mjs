// 将 WebSR 的 A4K 权重按计算着色器的读取顺序排列。偏移以 vec4 为单位。
import { readFileSync } from "node:fs";

function readLayers(model) {
  const bytes = readFileSync(new URL(`../vendor/websr/${model}.bin`, import.meta.url));
  let cursor = 12;
  function uint() {
    const value = bytes.readUInt32LE(cursor);
    cursor += 4;
    return value;
  }
  function floats(count) {
    const values = Array.from({ length: count }, (_, i) => bytes.readFloatLE(cursor + i * 4));
    cursor += count * 4;
    return values;
  }
  const layers = new Map();
  for (let i = 0; i < bytes.readUInt32LE(8); i++) {
    const length = uint();
    const name = bytes.toString("utf8", cursor, cursor + length);
    cursor += length;
    const weights = uint(), bias = uint();
    layers.set(name, { kernel: floats(weights), bias: floats(bias) });
  }
  return layers;
}

function pack(model) {
  const layers = readLayers(model), values = [], offsets = [];
  const groups = model === "cnn-s" ? 2 : 4;
  function layer(name) {
    const { bias, kernel } = layers.get(name);
    values.push(...bias, ...kernel);
  }
  if (model === "cnn-xs") {
    // XS 第一层按卷积位置交错保存四组输出，整理成与 S 相同的逐组布局。
    const stem = layers.get("stem");
    offsets.push(0);
    for (let group = 0; group < groups; group++) {
      values.push(...stem.bias.slice(group * 4, group * 4 + 4));
      for (let k = 0; k < 9; k++) {
        const i = (k * groups + group) * 16;
        values.push(...stem.kernel.slice(i, i + 16));
      }
    }
    for (const name of ["block0_dw", "block0_pw"]) {
      offsets.push(values.length / 4);
      layer(name);
    }
  } else {
    for (let stage = 0; stage <= 7; stage++) {
      offsets.push(values.length / 4);
      const name = stage === 7 ? "conv2d_last_tf" : stage === 0 ? "conv2d_tf" : `conv2d_${stage}_tf`;
      for (let group = 0; group < (stage === 7 ? 3 : groups); group++) layer(name + (group || ""));
    }
  }
  return { offsets, data: Buffer.from(new Float32Array(values).buffer).toString("base64") };
}
export const websrModels = Object.fromEntries(["cnn-xs", "cnn-s"].map(name => [name, pack(name)]));
