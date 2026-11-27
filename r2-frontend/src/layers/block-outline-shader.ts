import { sceneOcclusion } from "./scene-depth.ts";

/** 用十二个屏幕空间的窄矩形画格子的边，宽度以 CSS 像素计。 */
export const blockOutlineShader = /* wgsl */ `
${sceneOcclusion}
struct View {
  eyeHigh: vec4f, eyeLow: vec4f,
  right: vec4f, up: vec4f, forward: vec4f,
  css: vec2f, outputSize: vec2f,
}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var scene: texture_2d<f32>;

struct Edge {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) shape: vec4f, // 长、半宽、两端的前向深度
  @location(2) @interpolate(flat) color: vec4f,
  @location(3) @interpolate(flat) test: f32,
}
fn viewPoint(delta: vec3f) -> vec3f {
  return vec3f(dot(delta, view.right.xyz), dot(delta, view.up.xyz), dot(delta, view.forward.xyz));
}
fn screen(p: vec3f) -> vec2f {
  let divisor = select(1.0, p.z, view.forward.w != 0.0);
  return (vec2f(0.5) + p.xy * vec2f(view.right.w, -view.up.w) / divisor) * view.css;
}
@vertex fn vert(@builtin(vertex_index) i: u32, @location(0) highWidth: vec4f,
                @location(1) lowTest: vec4f, @location(2) color: vec4f) -> Edge {
  // 每个轴有四条平行边，由另外两个轴的角点位确定起点。
  let edge = i / 6u;
  let axis = edge / 4u;
  var start = vec3f(0);
  start[(axis + 1u) % 3u] = f32(edge & 1u);
  start[(axis + 2u) % 3u] = f32((edge >> 1u) & 1u);
  var end = start;
  end[axis] = 1.0;
  let base = (highWidth.xyz - view.eyeHigh.xyz) + (lowTest.xyz - view.eyeLow.xyz);
  var a = viewPoint(base + start);
  var b = viewPoint(base + end);
  var out: Edge;
  let near = 0.01;
  if (max(a.z,b.z) < near) { out.pos = vec4f(2,2,0,1); return out; }
  if (a.z < near) { a = mix(a,b,(near-a.z)/(b.z-a.z)); }
  if (b.z < near) { b = mix(b,a,(near-b.z)/(a.z-b.z)); }

  let origin = screen(a);
  let delta = screen(b) - origin;
  let len = length(delta);
  let along = select(vec2f(1,0), delta / max(len, 0.0001), len > 0.0001);
  let across = vec2f(-along.y, along.x);
  let vertex = array<u32,6>(0,1,2,2,1,3)[i % 6u];
  let halfWidth = highWidth.w * 0.5;
  let pad = halfWidth + max(view.css.x / view.outputSize.x, view.css.y / view.outputSize.y);
  out.local = vec2f(select(-pad,len+pad,(vertex & 1u)!=0u), select(-pad,pad,(vertex & 2u)!=0u));
  let pixel = origin + along*out.local.x + across*out.local.y;
  out.pos = vec4f(pixel / view.css * vec2f(2,-2) + vec2f(-1,1),0,1);
  out.shape = vec4f(len,halfWidth,a.z,b.z);
  out.color = color;
  out.test = lowTest.w;
  return out;
}
@fragment fn frag(edge: Edge) -> @location(0) vec4f {
  let len = edge.shape.x;
  let t = clamp(edge.local.x / max(len, 0.0001), 0.0, 1.0);
  let distance = length(vec2f(edge.local.x - clamp(edge.local.x,0.0,len), edge.local.y));
  let aa = max(fwidth(distance), 0.0001);
  let alpha = edge.color.a * clamp((edge.shape.y - distance) / aa + 0.5, 0.0, 1.0);
  if (edge.test != 0.0) {
    let a = edge.shape.z;
    let b = edge.shape.w;
    let z = select(mix(a,b,t), 1.0/mix(1.0/a,1.0/b,t), view.forward.w != 0.0);
    if (occluded(scene, edge.pos.xy / view.outputSize, z)) { discard; }
  }
  return vec4f(edge.color.rgb * alpha, alpha);
}`;
