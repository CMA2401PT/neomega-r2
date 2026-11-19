package texturepack

import (
	"encoding/json"
	"image"
	"image/color"
	"io/fs"
	"math"
	"path"
	"strings"
)

// bedrockBlocks 找到包根或 ZIP 外层目录下的方块贴图目录。
func bedrockBlocks(pack fs.FS) fs.FS {
	if pack == nil {
		return nil
	}
	dirs := []string{"textures/blocks"}
	entries, _ := fs.ReadDir(pack, ".")
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, path.Join(entry.Name(), "textures/blocks"))
		}
	}
	for _, dir := range dirs {
		if info, err := fs.Stat(pack, dir); err == nil && info.IsDir() {
			blocks, _ := fs.Sub(pack, dir)
			return blocks
		}
	}
	return nil
}

// 两版使用不同贴图名的常见建筑材料。
var bedrockNames = map[string]string{
	"bricks": "brick", "stone_bricks": "stonebrick", "oak_planks": "planks_oak",
	"sandstone": "sandstone_normal", "chiseled_stone_bricks": "stonebrick_carved",
	"cracked_stone_bricks": "stonebrick_cracked", "mossy_stone_bricks": "stonebrick_mossy",
}

// bedrockLayer 读取定义中的 PNG 引用或常量颜色；未提供的通道沿用原材质。
func bedrockLayer(blocks fs.FS, field json.RawMessage) *image.NRGBA {
	var name string
	if json.Unmarshal(field, &name) == nil && name != "" {
		data, err := fs.ReadFile(blocks, name+".png")
		if err != nil {
			return nil
		}
		img, err := decodePNG(data)
		if err != nil {
			return nil
		}
		// 方块动画的方形帧纵向排列，静态材质只使用首帧。
		w, h := img.Rect.Dx(), img.Rect.Dy()
		if h > w && h%w == 0 {
			frame := image.NewNRGBA(image.Rect(0, 0, w, w))
			copy(frame.Pix, img.Pix[:len(frame.Pix)])
			return frame
		}
		return img
	}
	var channels []uint8
	if json.Unmarshal(field, &channels) != nil || len(channels) < 3 {
		return nil
	}
	p := color.NRGBA{R: channels[0], G: channels[1], B: channels[2], A: 255}
	if len(channels) == 4 {
		p.A = channels[3]
	}
	return solid(p)
}

// readBedrockTile 将基岩的高度与 MER 转成渲染器已使用的法线和高光通道。
func readBedrockTile(blocks fs.FS, texture string) tile {
	var t tile
	name, ok := strings.CutPrefix(texture, "minecraft:block/")
	if !ok {
		return t
	}
	data, err := fs.ReadFile(blocks, name+".texture_set.json")
	if err != nil && bedrockNames[name] != "" {
		data, err = fs.ReadFile(blocks, bedrockNames[name]+".texture_set.json")
	}
	if err != nil {
		return t
	}
	var def struct {
		Set struct {
			Color, Normal, Heightmap json.RawMessage
			MER                      json.RawMessage `json:"metalness_emissive_roughness"`
		} `json:"minecraft:texture_set"`
	}
	if json.Unmarshal(data, &def) != nil {
		return t
	}
	if img := bedrockLayer(blocks, def.Set.Color); img != nil {
		t.color = img
	}
	if normal := bedrockLayer(blocks, def.Set.Normal); normal != nil {
		// 基岩的蓝通道是法线 Z，渲染器在这个位置读取遮蔽率。
		for i := 0; i < len(normal.Pix); i += 4 {
			normal.Pix[i+2] = 255
			normal.Pix[i+3] = 255
		}
		t.normal = normal
	} else if heights := bedrockLayer(blocks, def.Set.Heightmap); heights != nil {
		w, h := heights.Rect.Dx(), heights.Rect.Dy()
		t.normal = image.NewNRGBA(heights.Rect)
		height := func(x, y int) float64 {
			return float64(heights.NRGBAAt((x+w)%w, (y+h)%h).R) / 255
		}
		// 基岩高度图表示受光凹凸；1/16 仅作为生成斜率的强度，不写入 labPBR 视差深度。
		// A 固定为 255，让轮廓和颜色纹素留在原表面，避免把像素边界拉成阶梯侧壁。
		const normalStrength = 1.0 / 16.0
		for y := range h {
			for x := range w {
				dx := (height(x-1, y) - height(x+1, y)) * float64(w) * normalStrength / 2
				dy := (height(x, y-1) - height(x, y+1)) * float64(h) * normalStrength / 2
				scale := 127.5 / math.Sqrt(1+dx*dx+dy*dy)
				t.normal.SetNRGBA(x, y, color.NRGBA{
					R: byte(math.Round(127.5 + dx*scale)),
					G: byte(math.Round(127.5 + dy*scale)),
					B: 255,
					A: 255,
				})
			}
		}
	}
	if mer := bedrockLayer(blocks, def.Set.MER); mer != nil {
		// 渲染器区分金属和电介质。电介质取约 4% 的正入射反射率，254 是最亮的自发光。
		for i := 0; i < len(mer.Pix); i += 4 {
			m, e, r := mer.Pix[i], mer.Pix[i+1], mer.Pix[i+2]
			f0 := byte(10)
			if m >= 128 {
				f0 = 230
			}
			mer.Pix[i], mer.Pix[i+1], mer.Pix[i+2], mer.Pix[i+3] = 255-r, f0, 0, byte((uint16(e)*254+127)/255)
		}
		t.specular = mer
	}
	return t
}
