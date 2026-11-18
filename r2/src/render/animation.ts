import type { Camera } from "../contracts.ts";
import type { ObjectStore } from "../objects/store.ts";
import { cameraBasis as basis, PERSPECTIVE_SPAN as SPAN } from "./camera.ts";
export function hasVisibleAnimation(
  objects: ObjectStore,
  camera: Camera,
  { width, height }: { width: number; height: number },
): boolean {
  if (objects.enabled === false) return false;
  const { forward, right, up } = basis(camera),
    dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    halfHeight = (camera.ortho ?? SPAN) / 2,
    halfWidth = (halfHeight * width) / height;
  return objects.references().some(({ bounds: [low, high] }) => {
    const center = low.map((v, i) => (v + high[i]) / 2 - camera.position[i]),
      radius = Math.hypot(...high.map((v, i) => v - low[i])) / 2,
      depth = dot(center, forward);
    if (depth < -radius) return false;
    const reach = camera.ortho !== undefined ? 1 : Math.max(depth, 0);
    if ((2 * radius * height) / (camera.ortho ?? Math.max(depth, radius) * SPAN) < 1) return false;
    return (
      Math.abs(dot(center, right)) <= reach * halfWidth + 2 * radius &&
      Math.abs(dot(center, up)) <= reach * halfHeight + 2 * radius
    );
  });
}
