# 装配浏览器发布文件

各包分别编译渲染核心、连接协议、材质工具和前端。发布脚本收集这些构建产物。Go 宿主使用模块化网页，独立 HTML 使用带选定材质的单文件播放器；独立发布目录也包含两份可单独下载的材质包和素材声明。

在 neomega-r2 根目录执行以下命令，即可生成浏览器资源、装配两种页面并启动演示服务。

```sh
npm ci
npm run build
python3 assets-utils/resourcegen/generate.py --java 26.3 --topic browser-materials
node scripts/release-browser/assemble.mjs web scripts/release-browser/dist/web
node scripts/release-browser/assemble.mjs standalone scripts/release-browser/dist/standalone \
  assets-utils/generated/26.3/browser-materials
npm run demo
```

打开 <http://127.0.0.1:2415/> 查看模块化页面，打开 <http://127.0.0.1:2415/release/standalone.html> 查看单文件播放器。宿主已有材质服务时只需执行 `web` 装配，并提供自己的材质和配方地址。CI 将 `standalone` 的发行文件交给上一级的 `publish-cos.py`。
