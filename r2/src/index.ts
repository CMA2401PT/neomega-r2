// 目录版入口保留现有宿主的导入方式。
export * from "./core.ts";
export {
  r2linkSource,
  encodeMessage,
  decodeMessage,
  R2LINK_VERSION,
  type R2LinkSource,
  type R2LinkOptions,
  type R2LinkState,
  type R2LinkWelcome,
  type R2LinkScene,
  type R2LinkCamera,
} from "./source/r2link.ts";
