package r2

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"testing"

	"neomega-r2/internal/texturepack"
)

// TestTexturePack 使用真实资源表验证名字替换、三通道对齐和透明度派生，而非只测试图片读写。
func TestTexturePack(t *testing.T) {
	directory := t.TempDir()
	textureDir := filepath.Join(directory, "assets/minecraft/textures/block")
	if err := os.MkdirAll(textureDir, 0755); err != nil {
		t.Fatal(err)
	}
	writePNG := func(name string, w, h int, pixel func(int, int) color.NRGBA) {
		t.Helper()
		img := image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := range h {
			for x := range w {
				img.SetNRGBA(x, y, pixel(x, y))
			}
		}
		file, err := os.Create(filepath.Join(textureDir, name+".png"))
		if err != nil {
			t.Fatal(err)
		}
		if err = png.Encode(file, img); err != nil {
			t.Fatal(err)
		}
		if err = file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	writePNG("stone", 64, 64, func(x, y int) color.NRGBA {
		if x < 32 {
			return color.NRGBA{255, 0, 0, 255}
		}
		return color.NRGBA{0, 255, 0, 0}
	})
	writePNG("stone_n", 64, 64, func(x, y int) color.NRGBA { return color.NRGBA{32, 192, 77, 19} })
	// 材质包可以主动关闭原版灯块的自发光，255 是 labPBR 的不发光哨兵。
	writePNG("sea_lantern_s", 16, 16, func(x, y int) color.NRGBA { return color.NRGBA{A: 255} })
	writePNG("stone_s", 32, 32, func(x, y int) color.NRGBA { return color.NRGBA{203, 230, 11, 0} })
	writePNG("oak_leaves", 32, 32, func(x, y int) color.NRGBA { return color.NRGBA{255, 0, 255, 255} })
	writePNG("grass_block_side", 32, 32, func(x, y int) color.NRGBA { return color.NRGBA{0, 255, 255, 255} })
	writePNG("grass_block_side_overlay", 32, 32, func(x, y int) color.NRGBA { return color.NRGBA{255, 0, 0, 0} })
	writePNG("dandelion", 16, 16, func(x, y int) color.NRGBA { return color.NRGBA{0, 255, 255, 255} })
	writePNG("gold_block", 32, 64, func(x, y int) color.NRGBA {
		if y < 32 {
			return color.NRGBA{0, 255, 0, 255}
		}
		return color.NRGBA{0, 0, 255, 255}
	})
	if err := os.WriteFile(filepath.Join(textureDir, "gold_block.png.mcmeta"), []byte(`{"animation":{"frames":[{"index":1},0]}}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(textureDir, "dirt.png"), []byte("broken PNG"), 0644); err != nil {
		t.Fatal(err)
	}
	var manifest texturepack.Manifest
	data, err := Files.ReadFile("assets/textures.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	layer := func(name string) int {
		t.Helper()
		for i, parts := range manifest.Layers {
			if len(parts) == 1 && parts[0].Texture == "minecraft:block/"+name {
				return i
			}
		}
		t.Fatalf("缺少贴图 %s", name)
		return -1
	}
	readPixel := func(set *TextureSet, file string, id, x, y, level int) []byte {
		size, offset := set.Info.Side, 0
		for range level {
			offset += size * size * 4 * set.Info.Layers
			size /= 2
		}
		offset += (id*size*size + y*size + x) * 4
		return set.Files[file][offset : offset+4]
	}
	vanilla, err := BuildTextures("", 0)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := BuildTextures(directory, 128)
	if err != nil {
		t.Fatal(err)
	}
	if pack.Info.Side != 64 || pack.Info.Levels != 7 || pack.Info.Layers != 563 {
		t.Fatal(pack.Info)
	}
	assertPixel := func(got []byte, want []byte) {
		t.Helper()
		if !bytes.Equal(got, want) {
			t.Fatalf("像素 %v，期望 %v", got, want)
		}
	}
	// 发光在生成资源与运行时换包两条路径中一致，并且缩小后仍保留。
	for _, name := range []string{"sea_lantern", "glowstone", "shroomlight", "ochre_froglight_side", "verdant_froglight_top", "pearlescent_froglight_side"} {
		for level := range vanilla.Info.Levels {
			assertPixel(readPixel(vanilla, "surface-specular.bin", layer(name), 0, 0, level), []byte{0, 0, 0, 190})
		}
	}
	assertPixel(readPixel(vanilla, "surface-specular.bin", layer("redstone_lamp"), 0, 0, 0), []byte{0, 0, 0, 0})
	assertPixel(readPixel(vanilla, "surface-specular.bin", layer("redstone_lamp_on"), 0, 0, 0), []byte{0, 0, 0, 170})
	for level := range pack.Info.Levels {
		assertPixel(readPixel(pack, "surface-specular.bin", layer("sea_lantern"), 0, 0, level), []byte{0, 0, 0, 255})
	}
	generated, err := Files.ReadFile("assets/surface-specular.bin")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(generated, vanilla.Files["surface-specular.bin"]) {
		t.Fatal("预生成自发光资源与运行时合成不一致，请执行 go generate")
	}
	stone := layer("stone")
	assertPixel(readPixel(pack, "surface-layers.bin", stone, 0, 0, 0), []byte{255, 0, 0, 255})
	assertPixel(readPixel(pack, "surface-layers.bin", stone, 63, 0, 0), []byte{0, 0, 0, 0})
	assertPixel(readPixel(pack, "surface-layers.bin", stone, 0, 0, 6), []byte{188, 0, 0, 128})
	assertPixel(readPixel(pack, "surface-normals.bin", stone, 0, 0, 6), []byte{32, 192, 77, 19})
	assertPixel(readPixel(pack, "surface-specular.bin", stone, 0, 0, 6), []byte{203, 230, 11, 0})
	for _, name := range []string{"dirt", "cobblestone"} {
		id := layer(name)
		for y := range 16 {
			for x := range 16 {
				assertPixel(readPixel(pack, "surface-layers.bin", id, x*4, y*4, 0), readPixel(vanilla, "surface-layers.bin", id, x, y, 0))
			}
		}
		assertPixel(readPixel(pack, "surface-normals.bin", id, 0, 0, 0), []byte{128, 128, 255, 255})
		assertPixel(readPixel(pack, "surface-specular.bin", id, 0, 0, 6), []byte{0, 0, 0, 0})
	}
	assertPixel(readPixel(pack, "surface-layers.bin", layer("gold_block"), 0, 0, 0), []byte{0, 0, 255, 255})
	compositeFound := false
	for i, parts := range manifest.Layers {
		if len(parts) == 2 && parts[0].Texture == "minecraft:block/grass_block_side" && parts[1].Texture == "minecraft:block/grass_block_side_overlay" {
			compositeFound = true
			assertPixel(readPixel(pack, "surface-layers.bin", i, 0, 0, 0), []byte{0, 255, 255, 255})
		}
	}
	if !compositeFound {
		t.Fatal("未覆盖草方块侧面合成配方")
	}
	var current Catalog
	if err = json.Unmarshal(pack.Files["catalog.json"], &current); err != nil {
		t.Fatal(err)
	}
	stoneModel := current.Models[current.States[`minecraft:stone []`]]
	if stoneModel.Kind != 3 {
		t.Fatal("替换出的透明孔未进入镂空分类", stoneModel)
	}
	offset := int(stoneModel.Offset)*16 + 15*4
	alpha := math.Float32frombits(binary.LittleEndian.Uint32(pack.Files["fast.bin"][offset:]))
	if alpha != .5 {
		t.Fatal("代表色覆盖率未更新", alpha)
	}
	for state, id := range current.States {
		if len(state) >= 21 && state[:21] == "minecraft:oak_leaves [" && current.Models[id].Kind != 1 {
			t.Fatal("不透明树叶仍按镂空分类", state)
		}
	}
	var records []float32 = make([]float32, len(pack.Files["quad-records.bin"])/4)
	if err = binary.Read(bytes.NewReader(pack.Files["quad-records.bin"]), binary.LittleEndian, records); err != nil {
		t.Fatal(err)
	}
	seen := false
	for i, name := range manifest.Quads {
		if name == "minecraft:block/stone" {
			seen = true
			if records[i*28+14] != 1 {
				t.Fatal("复杂模型未采用新裁切模式")
			}
			x, y := int(math.Round(float64(records[i*28+16])*float64(pack.Info.AtlasWidth))), int(math.Round(float64(records[i*28+17])*float64(pack.Info.AtlasHeight)))
			at := (y*pack.Info.AtlasWidth + x) * 4
			assertPixel(pack.Files["atlas-normals.bin"][at:at+4], []byte{32, 192, 77, 19})
			assertPixel(pack.Files["atlas-specular.bin"][at:at+4], []byte{203, 230, 11, 0})
		}
		if name == "minecraft:block/dandelion" && records[i*28+14] != 0 {
			t.Fatal("不透明花仍按裁切模式")
		}
	}
	if !seen {
		t.Fatal("未覆盖复杂模型")
	}
	archivePath := filepath.Join(t.TempDir(), "pack.zip")
	archive, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(archive)
	err = fs.WalkDir(os.DirFS(directory), ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		data, err := os.ReadFile(filepath.Join(directory, path))
		if err != nil {
			return err
		}
		w, err := zw.Create(path)
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	zipped, err := BuildTextures(archivePath, 32)
	if err != nil {
		t.Fatal(err)
	}
	if zipped.Info.Side != 32 || zipped.Info.Levels != 6 {
		t.Fatal(zipped.Info)
	}
	assertPixel(readPixel(zipped, "surface-layers.bin", stone, 0, 0, 5), []byte{188, 0, 0, 128})
	assertPixel(readPixel(zipped, "surface-specular.bin", stone, 0, 0, 5), []byte{203, 230, 11, 0})
	var wire bytes.Buffer
	if _, err = zipped.WriteTo(&wire); err != nil {
		t.Fatal(err)
	}
	headerSize := binary.LittleEndian.Uint32(wire.Bytes())
	var header struct {
		Files []struct {
			Name   string
			Length int
		}
	}
	if err = json.Unmarshal(wire.Bytes()[4:4+headerSize], &header); err != nil {
		t.Fatal(err)
	}
	position := int(4 + headerSize)
	for _, entry := range header.Files {
		if !bytes.Equal(wire.Bytes()[position:position+entry.Length], zipped.Files[entry.Name]) {
			t.Fatal("传输快照错位", entry.Name)
		}
		position += (entry.Length + 3) / 4 * 4
	}
}
