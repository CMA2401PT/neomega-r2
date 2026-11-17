// 编译 TS 并复制着色器；dist 的目录结构与 src 相同，着色器按 import.meta.url 相对路径加载。
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src"),
  dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", root], {
  stdio: "inherit",
});
for (const entry of readdirSync(src, { recursive: true, withFileTypes: true }))
  if (entry.isFile() && entry.name.endsWith(".frag")) {
    const from = join(entry.parentPath, entry.name);
    cpSync(from, join(dist, from.slice(src.length)));
  }
