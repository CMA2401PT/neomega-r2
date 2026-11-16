# Windows D3D 编译问题交接

更新于 2026 年 11 月 16 日。接手目标是：**Windows 上普通浏览器直接打开网页即可使用完整功能，不要求浏览器启动参数或切换图形后端。** 用户接受适量运行性能损失，希望优先做保持运算逻辑的小改写；大幅重构执行流程不是已经确定的方案。

完整 D3D 着色器编译过慢的问题仍未解决。已提交的 `6856db6` 只修正 `locate()` 的一种控制流写法，消除了局部实验中的 D3D 校验错误和重试。不要把 OpenGL/Vulkan 出图、诊断版本编译成功，或这一个提交，称为完整问题已经修复。

## 已提交的修改与验证

`6856db6` 仅修改 [ray.frag](../web/render/ray.frag) 的 `locate()`：多个提前返回改为计算 `result` 后统一返回；保留层次跳跃、section/brick 缓存、调色板解码和附加片段地址查询。基线提交为 `efffe73`。

验证记录在 [results/windows-addback](results/windows-addback)：

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| D3D 遍历诊断，改写前 | 约 1411 ms 链接成功，但先报 X8000 并重试 | [locate-commit-before.json](results/windows-addback/locate-commit-before.json) |
| 同一诊断，正式改写后 | 约 596 ms 成功，无校验错误和重试 | [locate-commit-after.json](results/windows-addback/locate-commit-after.json) |
| 原版与改写版逐像素比较 | 8 组 SHA256 完全一致 | [locate-pixels.json](results/windows-addback/locate-pixels.json) |
| 工作区 Node 测试 | 17 项通过 | `node --test neomega-r2/tests/*.test.mjs` |

像素比较是在本机 OpenGL 后端进行的功能等价检查，不是 D3D 验收。覆盖 Möbius 和本地测试存档、hierarchy/ fragments 开关的四种组合，使用固定相机、光照、时间和 320×180 预览帧。未证明所有存档或累积采样逐像素等价。17 项测试中有 5 项来自尚未提交的启动错误诊断测试，见后面的工作区说明。

原始校验信息包括：

```text
warning X4000: use of potentially uninitialized variable (f_locate_int3_int_uint)
error X8000: Validation Error: source component 1 in temp r9 not initialized
Retrying with skip validation
Retrying with skip optimization
```

这是编译产物的校验错误；不能据此直接断言原 GLSL 的 `out` 参数没有初始化。原函数入口已初始化输出参数。统一返回是已验证有效的兼容改写，但不是完整超时的充分解释。

## 环境和关键文件

本机工作区为 `D:\Projects\mymc`，它本身不是 Git 仓库。`neomega-r2` 和 `apps/neomega-viewer-r2` 是两个独立仓库。测试硬件为 AMD Radeon 780M；测试浏览器为本机 Chrome。每次以日志里的实际 GPU 字符串为准，不要只看启动参数。

| 文件 | 用途 |
| --- | --- |
| `neomega-r2/web/render/ray.frag` | `locate`、表面着色、遍历、阴影、水面和反弹，主调查对象 |
| `neomega-r2/web/render/objects.frag` | 动态实例求交，构建时替换 `#include <objects>` |
| `neomega-r2/web/render/renderer.js` | 专门编译 `RENDER_PASS=0/1` 两个程序，等待 KHR 并行编译扩展 |
| [shader-addback.cjs](shader-addback.cjs) | 可提交的逐项加回实验；保存精确 GLSL、哈希、后端、耗时和完整编译日志 |
| [locate-compare.cjs](locate-compare.cjs) | 指定提交与工作区的像素对照，需要独立 viewer 服务 |
| `.r2-debug/ablation.cjs` | 旧实验生成器，位于工作区根目录；大量试验开关，不能当作生产实现 |
| `.r2-debug/ablation/*.frag` 和 `*.json` | 旧实验的精确输入和结果，比重新运行已修改的生成器更可靠 |
| `.r2-debug/native/` | 原生 D3DCompile、符号、采样脚本和捕获的 HLSL；本机临时材料，不在 Git 内 |

本机工具位置：

```text
Playwright: D:/Projects/mymc/.r2-debug/node_modules/playwright
Chrome: C:/Program Files/Google/Chrome/Application/chrome.exe
Go: C:/Users/daiji/AppData/Local/Programs/go/bin/go.exe
```

新环境可用 `npm install --prefix .r2-debug playwright` 安装实验依赖，再指定现有 Chrome；不必安装一份额外浏览器。以下 PowerShell 命令均从工作区根目录执行。

## 从可编译的版本逐项加回

优先用短时限加回实验，避免每次都等待完整程序数分钟。先确认已提交改写的局部效果：

```powershell
$env:PLAYWRIGHT_MODULE = 'D:/Projects/mymc/.r2-debug/node_modules/playwright'
$env:CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
Remove-Item Env:R2_ANGLE -ErrorAction SilentlyContinue

node neomega-r2/experiment/shader-addback.cjs --revision=efffe73 --stage=2 --timeout=3000 --output=.r2-debug/check-old
node neomega-r2/experiment/shader-addback.cjs --stage=2 --timeout=3000 --output=.r2-debug/check-current
```

`--revision` 同时固定 ray 和 objects 源码；省略则读取工作区。`--revision=efffe73 --single-locate` 使用旧源码加诊断用的统一返回替换，适合复现历史记录。**当前生产源码已经统一返回，不加 `--revision` 再使用 `--single-locate`，不能构成旧版/新版对照。**

运行整条加回序列：

```powershell
node neomega-r2/experiment/shader-addback.cjs --timeout=3000 --output=.r2-debug/current-ladder
```

| stage | 实际保留的路径 |
| --- | --- |
| 0 | 屏幕射线方向 |
| 1 | 单次空间查询 |
| 2 | 完整空间遍历，但立方体、模型和实例着色为空操作 |
| 3 | 加纯色立方体和简化颜色合成 |
| 4 | 加原版立方体贴图采样，仍使用简化颜色合成 |
| 5 | 恢复完整 `contribute()` 表面光照 |
| 6 | 恢复复杂静态模型 |
| 7 | 恢复动态实例 |
| 8 | 加直射阴影 |
| 9 | 原始完整 `tracePixel()` 与 `main()`，包括水面和反弹路径 |

0–8 是诊断程序，不能交付。它们采用单条主射线，输出 `steps` 以避免无表面遍历被整个优化掉；但没有被输出或后续使用的其他状态仍可能被优化掉。尤其不能把 stage 5 等同于“完整反弹逻辑已经编译通过”。

默认在第一次失败或超时后停止，每个阶段都使用独立浏览器进程并结束其进程树。GPU 编译实验应串行，防止上一轮超时任务继续消耗 CPU。不要结束用户的普通浏览器进程。

默认 `--pass=0` 是预览；用 `--pass=1` 选择累积。只有在较小边界得到明确改善后，才使用 `--stage=9` 对完整程序做一次有上限的验证，并分别记录两个 pass。不要每次改一行就重新等待完整程序超时。

## 下一步最值得做的实验

### 先把 stage 4 到 stage 5 拆细

这是目前较小、可重复、能在短时间看到变化的边界。建议在固定基线下逐项恢复 `contribute()` 的以下部分，而不是继续随机改写完整程序：

1. 原来的 alpha、水吸收、拾取和 unlit 分支；保留简化颜色输出。
2. 漫反射和环境光的数值计算。
3. GGX 高光及菲涅耳计算。
4. 代表阴影表面的记录。
5. 代表反弹表面的记录。

每次只改变一项；把新加的结果确实接到诊断输出，否则编译器可能将它删掉。记录 `shadeWeight`、`bounceWeight`、法线、位置等状态是否真正存活，必要时分别做输出，而不是仅观察源码里是否存在函数。旧生成器已有 `-control`、`-lighting`、`-diffuse`、`-spec-only` 等探索，但这些并不是完整、严密的加回矩阵，不要直接把它们当作结论。

找到稳定的“前一版快、后一版慢”后，固定两份 GLSL 的哈希，至少复测一次。再在慢版中二分刚加回的语句/状态，并尝试同计算的不同表达方式。3 秒只是筛选预算；已知一些有效程序需要 5–20 秒，超时不是编译错误。

### 再区分光照开销和跨射线状态开销

`tracePixel()` 保存主射线的光照、镜面和反弹状态，再调用阴影、水面和下一跳遍历。下面两类对照要分别做：

- 相同 `march()` 单次调用与两次调用，不新增任何新功能；让两次结果都影响输出。
- 一次调用后，逐项保留供后续射线使用的状态，观察状态存活范围是否就是昂贵部分。

旧实验一处 `march()` 调用约 14.4 秒，两处调用超过 30 秒；动态循环中共享调用位置约 24 秒。这些数据只说明增加调用和控制流有成本，**不足以证明指数膨胀，也没有证明合并调用就能修复完整版**。

不要立即写新的射线调度器或分多次绘制。先得到一个独立、精确的慢编译复现，再决定需要多大调整。用户更希望保持算法的小改写。

### 在最小复现上观察编译器

可通过 `WEBGL_debug_shaders.getTranslatedShaderSource(fragmentShader)` 获取 ANGLE 翻译出的 HLSL。该操作会等待 GLSL 翻译，应与后续 D3D 链接阶段分开计时。保存 GLSL、HLSL、后端、浏览器版本、宏和输入哈希。

本机 `.r2-debug/native/compile.ps1` 用 P/Invoke 调用 `D3DCompile`；`sample.ps1` 暂停自有测试线程、取得上下文并使用 DbgHelp 解析调用栈，最后恢复线程。它依赖 `.r2-debug/native` 下与实际 DLL 匹配的 PDB。相关符号信息保存在 [compiler-investigation.json](results/windows-addback/compiler-investigation.json)。

现有原生采样使用 **System32 的 D3DCompiler_47.dll、`D3DCOMPILE_SKIP_OPTIMIZATION=4`、累积 pass 1 的捕获 HLSL和简化输出封装**。它不是浏览器 GPU 进程采样，也不是完整预览 pass 0 的同一实验。不能直接断言 Chrome 一定停在同一位置。

若继续采样 Chrome：只跟踪本实验启动的浏览器进程树，查清 GPU 进程实际加载的编译器 DLL 路径和版本，再取对应 PDB。不要默认它与 System32 DLL 相同。采样可帮助判断哪个阶段昂贵，但源码触发点仍要靠上述受控加回实验定位。

## 已有证据及其边界

### 编译器仍在工作

[早期采样](results/windows-addback/compiler-stack-initial.txt)和[稍后采样](results/windows-addback/compiler-stack-later.txt)出现了：

```text
CCompiler::EmitFunction / EmitCallExpr / EmitExpression
CCompiler::EmitForLoop / EmitContinue / EmitSwitchInst
CCompiler::ResetNestedSimulation
CCompiler::FrontEndPropagateFlags
CProgram::PropagateFlags_AddInstLinks / MatchAndAppend
```

采样位置在变化，表明该原生测试在持续进行指令生成和数据流处理；禁用优化也没有跳过这些工作。尚未证明是某一种特定优化、某个循环展开规则或某个函数独自造成完整超时。不能把这些函数名当成已找到最小根因。

### 完整程序依然没有通过

最近一次完整预览测试在 120 秒内未完成，见 [compiler-investigation.json](results/windows-addback/compiler-investigation.json)。该测试除了统一返回的 `locate`，还包含实验性 `cubeSurface`/`specularLight` 统一返回和 `Hit` 完整初始化；**它不是 `6856db6` 单独修改的完整程序测量**。这些额外改写未进入生产源码。

统一返回之后，曾有单射线加模型约 5.5 秒、加阴影约 13 秒的结果；它们都缺少完整像素管线。此前提到的“21 秒版本”同样是删减功能的诊断程序，不是只降低了一点运行性能的完整版本。

### 没有带来完整修复的尝试

以下均为探索性否定结果，不是证明相应方向永远无效。精确输入保存在本机 `.r2-debug/ablation` 中，旧生成器继续变化后应优先使用已保存的 `.frag`。

| 尝试 | 本轮观察 |
| --- | --- |
| 把 `tracePixel`、阴影、模型等函数改为统一退出 | 未使已测路径在预算内更快完成 |
| 将进出介质和镂空面改为循环中的共同着色调用 | 单射线模型阶段超过 10 秒，没有改善 |
| 去掉模型求交和遍历中的 `continue` | 已测单射线路径超过 15 秒 |
| 将对象的动态向量下标改为轴选择，或组合布尔 `mix` | 已测带阴影路径超过 20 秒 |
| 主射线与水面反射经过同一个调用位置 | 仍超过 30 秒，没有验证完整功能等价 |
| 把遍历上限临时改成 2 | 完整诊断仍超过 12 秒；这个版本当然不能正常遍历世界 |
| 将 `locate` 的多个输出改成返回 `uvec4` | 光照诊断约 5.6 秒，没有构成完整修复 |

不要把取消了验证、阴影、模型、反弹、水面或采样后的成功编译包装成修复。

## 计时和成功标准

`shader-addback.cjs` 从提交 shader 编译之前计时，包含编译提交和链接等待；旧 `.r2-debug/ablation.cjs` 在 shader 编译提交之后、`linkProgram` 之前才开始计时。两组绝对数值不能直接混用，也都不是运行帧率。

浏览器完成状态必须在 `KHR_parallel_shader_compile` 允许的异步等待后查询；提前查询 `LINK_STATUS` 或编译日志可能同步卡住页面。完成状态查询前后、链接状态查询后都要检查上下文丢失。上下文丢失时拿到的 `null` 日志不代表具体着色器错误。

最终验收需要默认浏览器后端下的完整预览和累积两个 pass，并验证真实出图、HUD、拾取、地图、打开存档、复杂模型、透明体、水面和反弹。先做固定输入的画面等价对照，再测运行性能；不要因为链接成功就宣布完成。

## 其他工作区改动和交接边界

本次 `locate` 提交不包含以下之前遗留的工作。继续操作前分别执行两个仓库的 `git status`，不要把这些文件无意加入修复提交，也不要覆盖用户的新修改。

- 核心的 `web/render/renderer.js` 和 `tests/renderer-startup.test.mjs`：改进上下文丢失与 `null` 编译错误诊断；未提交。
- 应用的 `start-windows.ps1`、`start-vulkan.cmd`、`build-windows.ps1`：可选 Vulkan 启动入口及打包支持；未提交。下载目录也曾加入该入口。用户已明确这不满足最终目标，不要继续以更换后端替代 D3D 调查。
- 原生采样脚本、PDB、试验着色器、测试存档和 Playwright 安装位于根目录 `.r2-debug`，不属于任一 Git 仓库。不要假定新机器有它们。

OpenGL 和 Vulkan 只可作为同一着色器的对照后端。本机 Vulkan 原版程序曾完成默认场景、地图、静止累积和打开测试存档的检查；这不能证明默认 D3D 已修好，也不是此任务的交付标准。

像素对照脚本会重置指定服务的世界并打开测试存档，必须用独立测试端口，不能指向用户正在操作的会话。交接前已停止本次独立测试服务；原来用户的 2412 服务未动。需要重新验收时，可从应用构建产物启动独立服务：

```powershell
$testServer = Start-Process `
  -FilePath 'D:/Projects/mymc/apps/neomega-viewer-r2/dist/neomega-viewer-r2-windows-amd64.exe' `
  -ArgumentList '-listen','127.0.0.1:2421','-browser=false' `
  -WindowStyle Hidden -PassThru
$env:R2_URL = 'http://127.0.0.1:2421'
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  if ($testServer.HasExited) { throw '测试服务退出，请检查端口占用' }
  try {
    $null = Invoke-WebRequest "$env:R2_URL/api/world" -UseBasicParsing -TimeoutSec 2
    $ready = $true
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) { throw '测试服务未就绪' }
$env:R2_WORLD = 'D:/Projects/mymc/.r2-debug/daytime/world'
$env:R2_OUTPUT = 'D:/Projects/mymc/.r2-debug/locate-pixels-new.json'
node neomega-r2/experiment/locate-compare.cjs efffe73
# 完成后只停止刚创建、确认仍属于本次测试的进程。
Stop-Process -Id $testServer.Id
```

如果需要向用户汇报，先回答“完整默认 D3D 是否已修好”，再说明局部进展；尚未完成时明确写未完成。
