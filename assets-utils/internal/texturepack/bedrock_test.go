package texturepack

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
	"testing/fstest"
)

// 带外层目录的基岩包可以只覆盖材质通道，动态高度图应只用首帧计算斜率。
func TestBedrockHeightAndMER(t *testing.T) {
	heights := image.NewGray(image.Rect(0, 0, 4, 8))
	heights.SetGray(2, 1, color.Gray{Y: 175})
	heights.SetGray(1, 1, color.Gray{Y: 46})
	heights.SetGray(0, 4, color.Gray{Y: 255})
	var data bytes.Buffer
	if err := png.Encode(&data, heights); err != nil {
		t.Fatal(err)
	}
	pack := fstest.MapFS{
		"Defined/textures/blocks/brick.texture_set.json": {Data: []byte(`{"minecraft:texture_set":{"color":"missing","heightmap":"relief","metalness_emissive_roughness":[255,255,64]}}`)},
		"Defined/textures/blocks/relief.png":             {Data: data.Bytes()},
	}
	tile := readBedrockTile(bedrockBlocks(pack), "minecraft:block/bricks")
	if tile.color != nil || tile.normal.Bounds() != image.Rect(0, 0, 4, 4) {
		t.Fatal("颜色回退或高度图首帧不正确")
	}
	n := tile.normal.NRGBAAt(1, 1)
	if n.R >= 128 || n.G != 128 || n.B != 255 {
		t.Fatalf("向右升高的表面法线应朝左，实际为 %v", n)
	}
	if top := tile.normal.NRGBAAt(2, 1).A; top != 255 || n.A != 223 {
		t.Fatalf("首帧最高点应贴合方块面，凹处应按两种高度量程折算为 32 级高度差，实际为 %d、%d", top, n.A)
	}
	if s := tile.specular.NRGBAAt(0, 0); s != (color.NRGBA{R: 191, G: 230, A: 254}) {
		t.Fatalf("MER 通道转换有误，实际为 %v", s)
	}
}
