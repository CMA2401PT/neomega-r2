/** 颜色接受 CSS 颜色值，描边宽度按 CSS 像素计。默认与场景比较深度。 */
export interface OverlayStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  alwaysVisible?: boolean;
}
export type MarkerImage = HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement;
export interface MarkerStyle extends OverlayStyle {
  /** 以锚点为原点的像素轮廓，向右、向下为正；省略时画圆点。 */
  points?: readonly (readonly number[])[];
  /** 已加载的图像或自绘画布，居中放置。宽高省略时使用图像自身尺寸。 */
  image?: MarkerImage;
  width?: number;
  height?: number;
  /** 让标记的局部正 X 轴沿此世界方向投影，适用于指向玩家朝向的箭头。 */
  direction?: readonly number[];
}
export interface OverlayItem {
  remove(): void;
}
export interface OverlayMarker extends OverlayItem {
  setPosition(position: readonly number[]): void;
  setDirection(direction: readonly number[]): void;
  /** 自绘画布内容改变后，通知查看器重新取图。 */
  refresh(): void;
}
/** 查看器持有的场景标记。宿主只提交世界坐标，投影与场景遮挡随显示帧自动更新。 */
export interface SceneOverlay {
  marker(position: readonly number[], style?: MarkerStyle): OverlayMarker;
  polygon(points: readonly (readonly number[])[], style?: OverlayStyle): OverlayItem;
  line(points: readonly (readonly number[])[], style?: OverlayStyle): OverlayItem;
  blockOutline(position: readonly number[], style?: OverlayStyle): OverlayItem;
  blockFace(
    hit: { position: readonly number[]; normal: readonly number[] },
    style?: OverlayStyle,
  ): OverlayItem;
}
