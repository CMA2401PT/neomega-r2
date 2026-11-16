// 相机投影的公共数学；CPU 拾取与 GPU 绘制使用相同的像素中心和朝向约定。
export const PERSPECTIVE_SPAN = 2 * Math.tan((65 * Math.PI) / 360);

/** 把 yaw、pitch 转成右、上、前三条单位轴，供投影与叠加标记共用。
 * @param {{yaw:number,pitch:number}} camera
 */
export function cameraBasis({ yaw, pitch }) {
  return {
    forward: [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ],
    right: [Math.cos(yaw), 0, Math.sin(yaw)],
    up: [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      Math.cos(yaw) * Math.sin(pitch),
    ],
  };
}

/** 返回从左上角计数的像素中心射线；ortho 是画面高度覆盖的世界距离。
 * @param {{position:number[],yaw:number,pitch:number,ortho?:number}} camera
 * @param {{width:number,height:number,x:number,y:number}} pixel
 * @returns {{origin:number[],direction:number[]}}
 */
export function cameraRay(camera, { width, height, x, y }) {
  const { forward, right, up } = cameraBasis(camera);
  const span = camera.ortho ?? PERSPECTIVE_SPAN;
  const sx = ((x + 0.5) / width - 0.5) * (width / height) * span;
  const sy = (0.5 - (y + 0.5) / height) * span;
  const offset = right.map((v, i) => v * sx + up[i] * sy);
  if (camera.ortho !== undefined)
    return {
      origin: camera.position.map((v, i) => v + offset[i]),
      direction: forward,
    };
  const direction = forward.map((v, i) => v + offset[i]);
  const length = Math.hypot(...direction);
  return {
    origin: [...camera.position],
    direction: direction.map((v) => v / length),
  };
}
