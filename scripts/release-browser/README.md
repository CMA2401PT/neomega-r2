# 装配浏览器发布文件

各包分别编译渲染核心、连接协议、材质工具和前端。发布脚本收集这些构建产物。Go 宿主使用模块化网页，独立 HTML 使用带选定材质的单文件播放器；独立发布目录也包含两份可单独下载的材质包和素材声明。

在 neomega-r2 根目录运行 `npm run demo` 可以从当前源码启动本地演示。首次运行前需要执行 `npm ci` 并用下方的 `generate.py` 命令生成材质。演示读取 `assets-utils/generated/26.3/browser-materials`。如果资源生成在其他位置，将 `R2_GENERATED` 设为包含 `browser-materials/` 的版本目录。

要生成正式发布文件并预览指定的发布目录，运行以下命令。

```sh
npm ci
npm run build
python3 assets-utils/resourcegen/generate.py --java 26.3 --topic browser-materials
node scripts/release-browser/assemble.mjs web scripts/release-browser/dist/web
node scripts/release-browser/assemble.mjs standalone scripts/release-browser/dist/standalone \
  assets-utils/generated/26.3/browser-materials
node scripts/release-browser/serve.mjs scripts/release-browser/dist
```

打开 <http://127.0.0.1:2415/> 查看模块化页面，打开 <http://127.0.0.1:2415/release/standalone.html> 查看单文件播放器。宿主已有材质服务时只需执行 `web` 装配，并提供自己的材质和配方地址。CI 将 `standalone` 的发行文件交给上一级的 `publish-cos.py`。

## 从本地发布到 COS

在仓库根目录运行下面的命令，会把本地已装配的 `scripts/release-browser/dist/standalone` 中的四个 JS、两个材质 ZIP 和来源声明上传到 COS 的 `r2/`，覆盖同名文件。命令使用 uv 安装与 CI 同版本的 COS SDK。密钥从当前环境的 `T_COS_SECRET_ID` 和 `T_COS_SECRET_KEY` 读取。服务区域和公开访问地址沿用 CI 默认值，也可分别用 `T_COS_SERVICE_URL` 和 `T_COS_ACCESS_URL` 覆盖。

```sh
npm run publish:cos
```

如果 GitHub Actions 已经构建成功，可以下载并解压该次构建的 `r2-browser` 产物，把含有 `r2-frontend.js` 的目录直接交给同一命令。

```sh
npm run publish:cos -- /path/to/r2-browser
```
