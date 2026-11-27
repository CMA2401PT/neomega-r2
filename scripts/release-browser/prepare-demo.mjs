import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = join(scripts, "../..");
const demo = join(root, "r2-frontend/demo/dist");
const materials = join(process.env.R2_GENERATED ?? join(root, "assets-utils/generated/26.3"), "browser-materials");
const required = ["default-materials.zip", "material-info.zip", "THIRD_PARTY_NOTICES.txt"];
const missing = required.filter(name => !existsSync(join(materials, name)));
if (missing.length) {
  console.error(`演示缺少本地资源：${missing.join("、")}
查找目录：${materials}`);
  console.error("请先在 neomega-r2 根目录生成资源：\n  python3 assets-utils/resourcegen/generate.py --java 26.3 --topic browser-materials");
  if (process.env.R2_GENERATED) console.error("该命令生成在默认目录。使用默认目录时请取消设置 R2_GENERATED。");
  process.exit(1);
}

// 源码、入口与依赖一起构建，确保当前演示使用同一版模块。
execFileSync(process.execPath, [process.env.npm_execpath, "run", "build"], { cwd: root, stdio: "inherit" });
const assemble = join(scripts, "assemble.mjs");
execFileSync(process.execPath, [assemble, "web", join(demo, "web")], { stdio: "inherit" });
execFileSync(process.execPath, [assemble, "standalone", join(demo, "standalone"), materials], { stdio: "inherit" });
