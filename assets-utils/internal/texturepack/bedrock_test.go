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
	// 首帧最高点 175 贴住表面，中点 46 和谷底 0 按落差写入浅视差。
	for x, want := range []uint8{233, 239, 255} {
		if got := tile.normal.NRGBAAt(x, 1).A; got != want {
			t.Fatalf("纹素 (%d, 1) 的高度通道应为 %d，实际为 %d", x, want, got)
		}
	}
	if s := tile.specular.NRGBAAt(0, 0); s != (color.NRGBA{R: 191, G: 230, A: 254}) {
		t.Fatalf("MER 通道转换有误，实际为 %v", s)
	}
}

func TestBedrockUniformHeight(t *testing.T) {
	// 绝对灰度不是模型的高度；常量高度图在任意灰度下都应得到同一平面。
	for _, level := range []uint8{0, 127, 255} {
		var data bytes.Buffer
		if err := png.Encode(&data, solid(color.NRGBA{R: level, G: level, B: level, A: 255})); err != nil {
			t.Fatal(err)
		}
		pack := fstest.MapFS{
			"stone.texture_set.json": {Data: []byte(`{"minecraft:texture_set":{"heightmap":"height"}}`)},
			"height.png":             {Data: data.Bytes()},
		}
		tile := readBedrockTile(pack, "minecraft:block/stone")
		if n := tile.normal.NRGBAAt(0, 0); n != (color.NRGBA{R: 128, G: 128, B: 255, A: 255}) {
			t.Fatalf("常量高度 %d 应保持平面，实际为 %v", level, n)
		}
	}
}
