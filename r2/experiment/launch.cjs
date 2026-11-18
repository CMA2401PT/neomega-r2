// 验收脚本共用的浏览器启动。PLAYWRIGHT_MODULE 指定 playwright 模块的位置（默认按 Node 的解析找 playwright），
// CHROME 指定浏览器可执行文件（默认用 playwright 自带的 Chromium），R2_BROWSER_ARGS 以空格分隔追加参数，
// macOS 默认使用 ANGLE Metal。
function chromium() {
  try {
    return require(process.env.PLAYWRIGHT_MODULE || "playwright").chromium;
  } catch (error) {
    throw Error("找不到 playwright：安装它，或用 PLAYWRIGHT_MODULE 指向已有的模块目录。" + error.message);
  }
}

exports.launch = () =>
  chromium().launch({
    executablePath: process.env.CHROME || undefined,
    headless: true,
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
      ...(process.env.R2_BROWSER_ARGS || "").split(" ").filter(Boolean),
    ],
  });

/** 验证页地址，默认 npm run demo 的 2415。 */
exports.base = process.env.R2_URL || "http://127.0.0.1:2415";
