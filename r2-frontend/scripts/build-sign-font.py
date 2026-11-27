"""从 neomega-viewer-core 的 viewer/blockactor/sign/font 重建告示牌的固定字模。"""

import argparse
import gzip
import json
import struct
import zipfile
from pathlib import Path
from typing import NamedTuple

from PIL import Image


class Glyph(NamedTuple):
    width: int
    top: int
    advance: int
    bold_offset: int
    rows: list[int]


def bitmap_glyphs(source: Path) -> dict[int, Glyph]:
    """按原版的字体提供者顺序选择字形，并统一到两倍分辨率的文字坐标。"""
    glyphs: dict[int, Glyph] = {}
    for provider in json.loads((source / "bitmap.json").read_text())["providers"]:
        with Image.open(source / Path(provider["file"]).name) as texture:
            alpha = texture.convert("RGBA").getchannel("A")
        chars = provider["chars"]
        width, height = alpha.width // len(chars[0]), alpha.height // len(chars)
        scale = provider.get("height", 8) * 2 // height
        for y, line in enumerate(chars):
            for x, char in enumerate(line):
                if char == "\0" or ord(char) in glyphs:
                    continue
                cell = alpha.crop((x * width, y * height, (x + 1) * width, (y + 1) * height))
                cell = cell.resize((width * scale, height * scale), resample=Image.Resampling.NEAREST)
                bounds = cell.getbbox()
                ink_width = bounds[2] if bounds else 0
                rows = [
                    sum(1 << (ink_width - 1 - i) for i in range(ink_width) if cell.getpixel((i, j)))
                    for j in range(cell.height)
                ]
                glyphs[ord(char)] = Glyph(
                    width=ink_width,
                    top=2 * (7 - provider["ascent"]),
                    advance=((ink_width + 1) // 2 + 1) * 2,
                    bold_offset=2,
                    rows=rows,
                )
    return glyphs


def add_unifont(source: Path, glyphs: dict[int, Glyph]) -> None:
    """补齐默认位图以外的字符，用原版的宽度覆盖表裁掉字形两侧的空列。"""
    overrides = json.loads((source / "unifont.json").read_text())["size_overrides"]
    with zipfile.ZipFile(source / "unifont.zip") as archive:
        lines = archive.read("unifont_all_no_pua-16.0.01.hex").decode().splitlines()
    for line in lines:
        code, bitmap = line.split(":")
        point = int(code, 16)
        if point in glyphs:
            continue
        row_digits = len(bitmap) // 16
        columns = row_digits * 4
        rows = [int(bitmap[i:i + row_digits], 16) for i in range(0, len(bitmap), row_digits)]
        used = 0
        for row in rows:
            used |= row
        left = columns - used.bit_length() if used else 0
        right = columns - (used & -used).bit_length() if used else columns - 1
        for rule in overrides:
            if ord(rule["from"]) <= point <= ord(rule["to"]):
                left, right = rule["left"], rule["right"]
                break
        width = right - left + 1
        shift = columns - 1 - right
        mask = (1 << width) - 1
        glyphs[point] = Glyph(
            width=width,
            top=0,
            advance=(width // 2 + 1) * 2,
            bold_offset=1,
            rows=[(row >> shift if shift >= 0 else row << -shift) & mask for row in rows],
        )


def build(source: Path, output: Path) -> None:
    glyphs = bitmap_glyphs(source)
    add_unifont(source=source, glyphs=glyphs)
    glyphs[0x20] = Glyph(width=0, top=0, advance=8, bold_offset=2, rows=[])
    glyphs[0x200C] = Glyph(width=0, top=0, advance=0, bold_offset=0, rows=[])
    data = bytearray()
    for point, glyph in sorted(glyphs.items()):
        data.extend(struct.pack("<IBbBBB", point, glyph.width, glyph.top, glyph.advance, glyph.bold_offset, len(glyph.rows)))
        for row in glyph.rows:
            data.extend(row.to_bytes((glyph.width + 7) // 8, byteorder="little"))
    output.write_bytes(gzip.compress(bytes(data), compresslevel=9, mtime=0))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="包含 bitmap.json 与 unifont.zip 的目录")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "src/special-blocks/sign/glyphs.gz")
    args = parser.parse_args()
    build(source=args.source, output=args.output)
