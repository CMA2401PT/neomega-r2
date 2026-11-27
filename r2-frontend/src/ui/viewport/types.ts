import type { Camera, PreviewTier, Renderer, SessionStats } from "neomega-r2-core";
import type { Startup } from "../layout/startup.ts";
import type { ViewSettings } from "../settings/settings.ts";

export interface ViewStats {
  stats: SessionStats;
  shownTier: PreviewTier;
  median?: number;
  width: number;
  height: number;
}

export interface ViewOptions {
  renderer: Renderer;
  camera: Camera;
  settings: ViewSettings;
  startup?: Startup;
  scene(): { name?: string; ocean?: number; connection?: { state: string } };
  onSettings?(): void;
  onStats?(value: ViewStats): void;
  report?(event: string, detail?: Record<string, unknown>): void;
}
