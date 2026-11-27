/** 两种投影在共面处可能有舍入误差，所有图层共用以方块为单位的遮挡容差。 */
export const sceneOcclusion = /* wgsl */ `
fn occluded(depth: texture_2d<f32>, uv: vec2f, z: f32) -> bool {
  let size = vec2i(textureDimensions(depth));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
  let hit = textureLoad(depth, pixel, 0).r;
  return hit >= 0.0 && z > hit + 0.003;
}`;
