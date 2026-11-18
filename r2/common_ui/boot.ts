// 拼入宿主提供的按钮与设置，然后启动页面。只有显式加载此入口的页面会挂载 HUD。
const entry = document.querySelector<HTMLScriptElement>("script[data-entry]")!.dataset.entry!;
try {
  const response = await fetch(new URL("./layout.html", import.meta.url));
  if (!response.ok) throw Error("无法加载查看界面：" + response.status);
  const template = document.createElement("template");
  template.innerHTML = await response.text();
  for (const slot of template.content.querySelectorAll("slot")) {
    const extra = document.getElementById(slot.name);
    if (extra instanceof HTMLTemplateElement) slot.replaceWith(extra.content);
    else slot.remove();
  }
  document.body.prepend(template.content);
  const { startupStage, failStartup } = await import("./startup.js");
  try {
    await startupStage("正在加载渲染模块…");
    await import(new URL(entry, document.baseURI).href);
  } catch (error) {
    failStartup(error);
    console.error(error);
  }
} catch (error) {
  document.body.append(document.createTextNode("界面加载失败：" + error));
  console.error(error);
}
