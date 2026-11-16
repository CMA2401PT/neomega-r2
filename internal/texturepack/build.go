package texturepack

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	"io"
	"io/fs"
	"maps"
	"math"
	"neomega-r2/internal/modeldata"
	"slices"
)

// textureInputs 把名字、合成配方与实际图片放在一起，供数组和图集共用。
type textureInputs struct {
	manifest Manifest
	tiles    map[string]tile
	side     int
}

// atlasMapping 记录图集区域及其透明孔，模型表据此更新采样位置和裁切模式。
type atlasMapping struct {
	regions map[string][4]float32
	holes   map[string]bool
}

// Build 从原版基表合成整套贴图及匹配的模型表，供宿主一次替换。
func Build(source fs.FS, pack fs.FS, limit int) (*Set, error) {
	inputs, err := readTextures(source, pack, limit)
	if err != nil {
		return nil, err
	}
	set := &Set{
		Info: Info{
			Side:   inputs.side,
			Levels: 1 + int(math.Log2(float64(inputs.side))),
			Layers: len(inputs.manifest.Layers),
		},
		Files: map[string][]byte{},
	}
	layerColors := set.buildSurfaceLayers(inputs.manifest.Layers, inputs.tiles)
	atlas := set.buildAtlas(inputs.manifest.Quads, inputs.tiles, limit)
	if err = set.rebuildModelTables(
		source,
		inputs.manifest.Quads,
		layerColors,
		atlas,
	); err != nil {
		return nil, err
	}
	set.Files["textures-info.json"], err = json.Marshal(set.Info)
	if err != nil {
		return nil, err
	}
	return set, nil
}

// readTextures 按名字覆盖原版首帧，并确定三张表面数组共用的层边长。
func readTextures(source fs.FS, pack fs.FS, limit int) (textureInputs, error) {
	var manifest Manifest
	data, err := fs.ReadFile(source, "textures.json")
	if err != nil {
		return textureInputs{}, err
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		return textureInputs{}, err
	}
	data, err = fs.ReadFile(source, "base-atlas.png")
	if err != nil {
		return textureInputs{}, err
	}
	atlas, err := decodePNG(data)
	if err != nil {
		return textureInputs{}, err
	}
	tiles := map[string]tile{}
	side := 16
	names := slices.Sorted(maps.Keys(manifest.Textures))
	for _, name := range names {
		region := manifest.Textures[name]
		rect := image.Rect(
			int(math.Round(float64(region[0])*float64(atlas.Rect.Dx()))),
			int(math.Round(float64(region[1])*float64(atlas.Rect.Dy()))),
			int(math.Round(float64(region[0]+region[2])*float64(atlas.Rect.Dx()))),
			int(math.Round(float64(region[1]+region[3])*float64(atlas.Rect.Dy()))),
		)
		original := image.NewNRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
		draw.Draw(original, original.Rect, atlas, rect.Min, draw.Src)
		t := tile{
			color:    original,
			normal:   solid(color.NRGBA{128, 128, 255, 255}),
			specular: solid(color.NRGBA{}),
		}
		for channel, suffix := range []string{"", "_n", "_s"} {
			if replacement := readTile(pack, name, suffix); replacement != nil {
				side = max(side, replacement.Rect.Dx(), replacement.Rect.Dy())
				switch channel {
				case 0:
					t.color = replacement
				case 1:
					t.normal = replacement
				case 2:
					t.specular = replacement
				}
			}
		}
		tiles[name] = t
	}
	// 应用提供二次幂上限；非标准边长向上取整以保留完整 mip 链。
	size := 16
	for size < side {
		size *= 2
	}
	side = min(size, limit)
	return textureInputs{
		manifest: manifest,
		tiles:    tiles,
		side:     side,
	}, nil
}

// buildSurfaceLayers 按面配方生成三通道 mip，同时保留改写模型表需要的颜色与覆盖率。
func (s *Set) buildSurfaceLayers(recipes [][]Part, tiles map[string]tile) []layerColor {
	side := s.Info.Side
	colors := make([]layerColor, len(recipes))
	layerTiles := map[string]tile{}
	for _, parts := range recipes {
		for _, part := range parts {
			if _, exists := layerTiles[part.Texture]; exists {
				continue
			}
			t := tiles[part.Texture]
			images := []*image.NRGBA{t.color, t.normal, t.specular}
			for channel, img := range images {
				if img.Rect.Dx() > side || img.Rect.Dy() > side {
					images[channel] = resize(img, side, side, channel == 0)
				}
			}
			layerTiles[part.Texture] = tile{
				color:    images[0],
				normal:   images[1],
				specular: images[2],
			}
		}
	}
	channels := []string{"surface-layers.bin", "surface-normals.bin", "surface-specular.bin"}
	total := 0
	for size := side; size >= 1; size /= 2 {
		total += size * size * 4 * len(colors)
	}
	for _, name := range channels {
		s.Files[name] = make([]byte, total)
	}
	for i, parts := range recipes {
		pixels := compose(parts, layerTiles, side)
		colors[i] = measureLayer(pixels.color)
		for channel, img := range []*image.NRGBA{pixels.color, pixels.normal, pixels.specular} {
			offset := 0
			for _, data := range mipBytes(img, channel == 0) {
				copy(s.Files[channels[channel]][offset+i*len(data):], data)
				offset += len(data) * len(colors)
			}
		}
	}
	return colors
}

// buildAtlas 为四边形贴图装箱，三张图共用区域，避免颜色与材质属性错位。
func (s *Set) buildAtlas(quads []string, tiles map[string]tile, limit int) atlasMapping {
	atlasNames := slices.Clone(quads)
	slices.Sort(atlasNames)
	atlasNames = slices.Compact(atlasNames)
	rectangles := map[string]image.Rectangle{}
	area, maxWidth := 0, 1
	for _, name := range atlasNames {
		t := tiles[name]
		edge := min(limit, max(
			t.color.Rect.Dx(), t.color.Rect.Dy(),
			t.normal.Rect.Dx(), t.normal.Rect.Dy(),
			t.specular.Rect.Dx(), t.specular.Rect.Dy(),
		))
		scale := float64(edge) / float64(max(t.color.Rect.Dx(), t.color.Rect.Dy()))
		w := max(1, int(math.Round(float64(t.color.Rect.Dx())*scale)))
		h := max(1, int(math.Round(float64(t.color.Rect.Dy())*scale)))
		rectangles[name] = image.Rect(0, 0, w, h)
		area += w * h
		maxWidth = max(maxWidth, w)
	}
	width := 1
	for width < max(maxWidth, int(math.Ceil(math.Sqrt(float64(area))))) {
		width *= 2
	}
	x, y, rowHeight := 0, 0, 0
	for _, name := range atlasNames {
		rect := rectangles[name]
		if x+rect.Dx() > width {
			x = 0
			y += rowHeight
			rowHeight = 0
		}
		rectangles[name] = rect.Add(image.Pt(x, y))
		x += rect.Dx()
		rowHeight = max(rowHeight, rect.Dy())
	}
	height := 1
	for height < y+rowHeight {
		height *= 2
	}
	s.Info.AtlasWidth = width
	s.Info.AtlasHeight = height
	atlasImages := [3]*image.NRGBA{}
	for i := range 3 {
		atlasImages[i] = image.NewNRGBA(image.Rect(0, 0, width, height))
	}
	regions := map[string][4]float32{}
	atlasHoles := map[string]bool{}
	for _, name := range atlasNames {
		rect := rectangles[name]
		regions[name] = [4]float32{
			float32(rect.Min.X) / float32(width),
			float32(rect.Min.Y) / float32(height),
			float32(rect.Dx()) / float32(width),
			float32(rect.Dy()) / float32(height),
		}
		t := tiles[name]
		for channel, img := range []*image.NRGBA{t.color, t.normal, t.specular} {
			pixels := resize(img, rect.Dx(), rect.Dy(), channel == 0)
			draw.Draw(atlasImages[channel], rect, pixels, image.Point{}, draw.Src)
			if channel == 0 {
				atlasHoles[name] = holes(pixels, 26)
			}
		}
	}

	for i, name := range []string{"atlas-color.bin", "atlas-normals.bin", "atlas-specular.bin"} {
		s.Files[name] = atlasImages[i].Pix
	}
	return atlasMapping{regions: regions, holes: atlasHoles}
}

// rebuildModelTables 从原版基表重算代表色、透明分类和图集区域，避免沿用上一材质包的结果。
func (s *Set) rebuildModelTables(
	source fs.FS,
	quads []string,
	layerColors []layerColor,
	atlas atlasMapping,
) error {
	var catalog modeldata.Catalog
	data, err := fs.ReadFile(source, "base-catalog.json")
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &catalog); err != nil {
		return err
	}
	fast, err := readFloats(source, "base-fast.bin")
	if err != nil {
		return err
	}
	records, err := readFloats(source, "base-quad-records.bin")
	if err != nil {
		return err
	}
	var headers []uint32
	for i, m := range catalog.Models {
		if m.Kind == 1 || m.Kind == 3 {
			m.Kind = 1
			for face := range 6 {
				offset := int(m.Offset)*4 + face*16
				layer := int(fast[offset+6])
				if layer < 0 {
					continue
				}
				color := layerColors[layer]
				mode := int(fast[offset+7]) & 1
				if mode == 0 && color.alpha[0] < 1 {
					m.Kind = 3
				}
				for c := range 3 {
					fast[offset+12+c] = float32(srgb(color.rgb[mode][c]*float64(fast[offset+8+c]))) / 255
				}
				fast[offset+15] = float32(color.alpha[mode]) * fast[offset+11]
			}
		}
		catalog.Models[i] = m
		headers = append(headers, m.Kind, m.Offset, m.Count, m.Group)
	}
	for i, name := range quads {
		offset := i * 28
		region := atlas.regions[name]
		copy(records[offset+16:offset+20], region[:])
		if records[offset+14] != 2 {
			records[offset+14] = 0
			if atlas.holes[name] {
				records[offset+14] = 1
			}
		}
	}
	catalog.Statistics["surfaceLayers"] = len(layerColors)
	s.Files["catalog.json"], err = json.Marshal(catalog)
	if err != nil {
		return err
	}
	for name, value := range map[string]any{
		"headers.bin":      headers,
		"fast.bin":         fast,
		"quad-records.bin": records,
	} {
		var buffer bytes.Buffer
		if err = binary.Write(&buffer, binary.LittleEndian, value); err != nil {
			return err
		}
		s.Files[name] = buffer.Bytes()
	}
	return nil
}

// readFloats 返回可修改的基表副本，材质包之间不共享派生状态。
func readFloats(source fs.FS, name string) ([]float32, error) {
	data, err := fs.ReadFile(source, name)
	if err != nil {
		return nil, err
	}
	values := make([]float32, len(data)/4)
	err = binary.Read(bytes.NewReader(data), binary.LittleEndian, values)
	return values, err
}

// WriteTo 将整个快照写入单个响应，HTTP 不必维护全局当前材质包或版本目录。
func (s *Set) WriteTo(w io.Writer) (int64, error) {
	type entry struct {
		Name   string `json:"name"`
		Length int    `json:"length"`
	}
	var entries []entry
	names := slices.Sorted(maps.Keys(s.Files))
	for _, name := range names {
		entries = append(entries, entry{name, len(s.Files[name])})
	}
	header, err := json.Marshal(struct {
		Info  Info    `json:"info"`
		Files []entry `json:"files"`
	}{
		Info:  s.Info,
		Files: entries,
	})
	if err != nil {
		return 0, err
	}
	for len(header)%4 != 0 {
		header = append(header, ' ')
	}
	var size [4]byte
	binary.LittleEndian.PutUint32(size[:], uint32(len(header)))
	var written int64
	chunks := [][]byte{size[:], header}
	for _, name := range names {
		data := s.Files[name]
		chunks = append(chunks, data, make([]byte, (4-len(data)%4)%4))
	}
	for _, data := range chunks {
		n, err := w.Write(data)
		written += int64(n)
		if err != nil {
			return written, err
		}
	}
	return written, nil
}
