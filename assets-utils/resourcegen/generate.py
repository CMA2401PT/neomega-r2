"""从指定 Java 客户端生成 R2 渲染和存档修复所需的资源。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ASSETS = Path(__file__).resolve().parents[1]
BLOCKS = ASSETS.parents[1] / "neomega-blocks"
DEPENDENCIES = {
    "java-blocks": (),
    "java-assets": (),
    "block-geometry": ("java-assets", "java-blocks"),
    "item-models": ("java-assets",),
    "solid-faces": ("block-geometry",),
    "top-colors": ("block-geometry",),
    "cube-materials": ("top-colors",),
    "browser-materials": ("cube-materials",),
}
BLOCK_FILES = ("java_states.list", "java_compatibility.list", "java_block_schema.list", "java_default_properties.json")


def required_topics(topics: set[str]) -> set[str]:
    """展开主题依赖，以便多个产物共用一次方块状态和几何生成。"""
    required: set[str] = set()

    def include(topic: str) -> None:
        required.add(topic)
        for dependency in DEPENDENCIES[topic]:
            if dependency not in required:
                include(dependency)

    for topic in topics:
        include(topic)
    return required


def prepare_java_blocks(*, java: str, output: Path, deliver: bool, existing: Path | None) -> None:
    """烘焙几何只用状态名录和兼容映射，交付修复器时还需要属性域和默认属性。"""
    if existing is not None:
        for name in BLOCK_FILES if deliver else BLOCK_FILES[:2]:
            shutil.copyfile(existing / name, output / name)
        return
    topics = ["--topic", "block-updater"]
    if deliver:
        topics += ["--topic", "java-schema", "--topic", "canon"]
    subprocess.run(
        ["uv", "run", "--locked", "--project", BLOCKS, "python", BLOCKS / "resourcegen/generate.py",
         "--java", java, "--out", output, *topics],
        check=True,
    )


def prepare_client(*, java: str, work: Path, jar: Path | None, templates: Path | None) -> None:
    """从本地或在线取得的客户端提取模型，并核对客户端自身记录的版本。"""
    client = work / "java-assets"
    args = ["-jar", jar] if jar else ["-version", java]
    if templates is not None:
        args += ["-templates", templates]
    subprocess.run(
        ["go", "run", "./resourcegen/java-assets/cmd", "build", *args, "-work", work / "extract", "-out", client],
        cwd=ASSETS, check=True,
    )
    version = json.loads((client / "build-info.json").read_text())["version"]
    if java != version:
        raise ValueError(f"请求了 Java {java}，客户端实际为 {version}")


def pack_browser_materials(work: Path) -> None:
    """把配方和图集交给浏览器材质编译器打包。"""
    recipe = work / "recipe"
    shutil.copyfile(work / "java-assets/block-atlas.png", recipe / "base-atlas.png")
    subprocess.run(
        ["node", "resourcegen/browser-materials/pack.mjs", recipe, work / "browser-materials"],
        cwd=ASSETS, check=True,
    )


def include_notices(*, topics: set[str], work: Path) -> None:
    """每个主题可独立分发，随产物保留实际用到的客户端和方块数据来源。"""
    pymc = BLOCKS / "resourcegen/pymc"
    for topic in topics:
        output = work / topic
        if topic == "java-blocks":
            for name in ("LICENSE", "NOTICE.md"):
                shutil.copyfile(pymc / name, output / name)
        elif topic != "java-assets":
            notice = (work / "java-assets/THIRD_PARTY_NOTICES.txt").read_text()
            if "java-blocks" in required_topics({topic}):
                notice += "\n" + (pymc / "NOTICE.md").read_text() + "\n" + (pymc / "LICENSE").read_text()
            (output / "THIRD_PARTY_NOTICES.txt").write_text(notice)


def generate(
    *,
    java: str,
    topics: set[str],
    out: Path,
    jar: Path | None = None,
    templates: Path | None = None,
    blocks: Path | None = None,
) -> Path:
    """按版本生成所选主题。调用方已生成同版本方块数据时，可传入目录供烘焙复用。"""
    required = required_topics(topics)
    dest = out / java
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r2-", dir=dest) as directory:
        work = Path(directory).resolve()
        for topic in required:
            (work / topic).mkdir()
        if "java-blocks" in required:
            prepare_java_blocks(java=java, output=work / "java-blocks", deliver="java-blocks" in topics, existing=blocks)
        if "java-assets" in required:
            prepare_client(java=java, work=work, jar=jar, templates=templates)
        compiled = required - {"java-assets", "java-blocks"}
        if "browser-materials" in required:
            (work / "recipe").mkdir()
        if compiled:
            subprocess.run(["go", "run", "./resourcegen/compile", "-java", java,
                            "-work", work, *sorted(compiled)], cwd=ASSETS, check=True)
        if "browser-materials" in required:
            pack_browser_materials(work)
        include_notices(topics=topics, work=work)
        for topic in sorted(topics):
            source = work / topic
            for path in source.rglob("*"):
                if path.is_file():
                    target = dest / topic / path.relative_to(source)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    path.replace(target)
    return dest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java", required=True, help="Java 客户端版本")
    parser.add_argument("--out", type=Path, default=ASSETS / "generated", help="输出根目录，按版本和主题分目录")
    parser.add_argument("--topic", choices=DEPENDENCIES, action="append", help="可重复，默认生成全部主题")
    parser.add_argument("--jar", type=Path, help="使用已有的同版本客户端 JAR")
    parser.add_argument("--templates", type=Path, help="特殊方块模板目录，默认使用随生成器分发的社区输入")
    args = parser.parse_args()
    generate(java=args.java, topics=set(args.topic or DEPENDENCIES), out=args.out.resolve(),
             jar=args.jar.resolve() if args.jar else None, templates=args.templates.resolve() if args.templates else None)
