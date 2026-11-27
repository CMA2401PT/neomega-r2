# 特殊方块素材

附魔书的书皮、陶片纹样、旗帜遮罩和告示牌的默认位图字形来自 Minecraft Java 客户端。素材保留原权利人的权利。旗帜与陶罐将固定图片按名称排列成图集，浏览器按格取样。素材与模型尺寸的参考实现见 [neomega-viewer-core](https://github.com/CMA2401PT/neomega-viewer-core/tree/main/viewer/blockactor)。

告示牌字模合并了默认位图和 GNU Unifont 16.0.01。更新字库时，在装有 Pillow 的 Python 环境中运行 `python3 scripts/build-sign-font.py /path/to/neomega-viewer-core/viewer/blockactor/sign/font`（工作目录为 `r2-frontend`）。字库按 Unicode 码点排序，每条记录由小端码点、宽度、基线偏移、前进距离、粗体偏移、高度和逐行位掩码构成；整体使用 gzip 压缩。Unifont 的作者及授权见 [UNIFONT-LICENSE.txt](sign/UNIFONT-LICENSE.txt)。
