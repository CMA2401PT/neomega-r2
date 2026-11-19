// 镜头与布光使用同一份设置；颜色选择器显示 sRGB，照明计算使用线性 RGB。
import type { Camera, LightingOptions } from "/r2/index.js";
import { element } from "./hud.js";

export const appearanceDefaults = {
  fov: 65, exposureEV: 0, autoExposure: true,
  manualSun: false, azimuth: 210, elevation: 24,
  directColor: "#ffffff", autoSunColor: false, directStrength: 1, skyColor: "#ffffff", skyStrength: 1, airOpacity: 15, solarHaze: false, cloudShadows: false,
};
export type Appearance = typeof appearanceDefaults;
const radians = Math.PI / 180;

/** 把选中的色调与亮度合并成直射或天空的线性乘数。 */
function lightGain(color: string, strength: number): number[] {
  return [1, 3, 5].map(start => {
    const s = parseInt(color.slice(start, start + 2), 16) / 255;
    return strength * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  });
}

/** 固定布光按世界方位放置太阳；跟随时间时沿原有昼夜轨道运行。 */
export function lighting(settings: Appearance, hours: number): LightingOptions {
  const altitude = settings.elevation * radians, bearing = settings.azimuth * radians;
  const orbit = (hours - 6) * Math.PI / 12;
  return {
    sun: settings.manualSun
      ? [Math.sin(bearing) * Math.cos(altitude), Math.sin(altitude), -Math.cos(bearing) * Math.cos(altitude)]
      : [Math.cos(orbit), Math.sin(orbit), 0.3],
    sunColor: lightGain(settings.directColor, 1),
    autoSunColor: settings.autoSunColor,
    directLight: Array(3).fill(settings.directStrength),
    skyLight: lightGain(settings.skyColor, settings.skyStrength),
    exposureEV: settings.exposureEV,
    autoExposure: settings.autoExposure,
    solarHaze: settings.solarHaze,
    cloudShadows: settings.cloudShadows,
    airExtinction: -Math.log1p(-settings.airOpacity / 100) / 100,
  };
}

function compass(degrees: number): string {
  const names = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return names[Math.round(degrees / 45) % 8] + " " + degrees + "°";
}

/** 拖动控件即时更新画面；飞行转头时方位读数也跟着当前镜头。 */
export function bindAppearance(settings: Appearance, camera: Camera, changed: () => void) {
  // 朝向与俯仰在飞行中不断变化，只在相机页签可见时回写滑条。
  const panel = element("settings-camera");
  const ranges = ["fov", "exposureEV", "azimuth", "elevation", "directStrength", "skyStrength", "airOpacity"] as const;
  const switches = ["manualSun", "autoExposure", "autoSunColor", "solarHaze", "cloudShadows"] as const;
  const colors = ["directColor", "skyColor"] as const;
  function refresh() {
    camera.fov = settings.fov;
    for (const key of ranges) {
      const input = element<HTMLInputElement>(key);
      const value = settings[key];
      input.value = String(value);
      const label = key === "azimuth" ? compass(value)
        : key === "airOpacity" ? value + "%"
        : key === "exposureEV" ? value + " EV"
        : key.endsWith("Strength") ? value + "×" : value + "°";
      element(key + "-value").textContent = label;
      input.setAttribute("aria-valuetext", label);
    }
    for (const key of colors) element<HTMLInputElement>(key).value = settings[key];
    for (const key of switches) element<HTMLInputElement>(key).checked = settings[key];
    element("sun-position").hidden = !settings.manualSun;
  }
  function apply() {
    refresh();
    changed();
  }
  for (const key of ranges) {
    const input = element<HTMLInputElement>(key);
    input.oninput = () => { settings[key] = input.valueAsNumber; apply(); };
  }
  for (const key of colors) {
    const input = element<HTMLInputElement>(key);
    input.oninput = () => { settings[key] = input.value; apply(); };
  }
  for (const key of switches) {
    const input = element<HTMLInputElement>(key);
    input.onchange = () => { settings[key] = input.checked; apply(); };
  }
  const angles = ["yaw", "pitch"] as const;
  for (const key of angles) {
    const input = element<HTMLInputElement>(key);
    input.oninput = () => { camera[key] = input.valueAsNumber * radians; syncAngles(); changed(); };
  }
  function syncAngles() {
    if (!panel.checkVisibility()) return;
    for (const key of angles) {
      const value = Math.round(camera[key] / radians);
      const degrees = key === "yaw" ? ((value % 360) + 360) % 360 : value;
      const input = element<HTMLInputElement>(key);
      input.value = String(degrees);
      const label = key === "yaw" ? compass(degrees) : degrees + "°";
      input.setAttribute("aria-valuetext", label);
      element(key + "-value").textContent = label;
    }
  }
  element("appearance-reset").onclick = () => { Object.assign(settings, appearanceDefaults); apply(); };
  refresh();
  return { refresh, syncAngles };
}
