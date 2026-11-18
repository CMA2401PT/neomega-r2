// 资源生成从复制的静态资源提取一次模型，运行服务不会导入此命令或源几何解码器。
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"slices"
	"strings"

	java "neomega-blocks/presets/java/v1"
	"neomega-view-utils/r2assets"
	"neomega-view-utils/r2assets/internal/modeldata"
	geometry "neomega-view-utils/r2assets/internal/sourcegeometry"
	"neomega-view-utils/r2assets/internal/texturepack"
)

type cubeMaterial struct {
	Faces    [6][4]byte
	Group    uint32
	Textures [6][12]float32
}
type record struct {
	State    string
	Material cubeMaterial
	Known    bool
}

func main() {
	if err := generate(); err != nil {
		panic(err)
	}
}

func generate() error {
	source, err := os.Open("sourceassets/geometry.nvtables")
	if err != nil {
		return err
	}
	defer source.Close()
	tables, err := geometry.DecodeTables[uint32](source)
	if err != nil {
		return err
	}
	compressed, err := os.ReadFile("sourceassets/materials.gob.gz")
	if err != nil {
		return err
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return err
	}
	defer reader.Close()
	var records []record
	if err = gob.NewDecoder(reader).Decode(&records); err != nil {
		return err
	}
	cubes := map[string]cubeMaterial{}
	for _, r := range records {
		cubes[r.State] = r.Material
	}
	states := map[string]uint32{}
	catalog := r2assets.Catalog{
		Models:     []r2assets.Model{{}},
		Statistics: map[string]int{},
	}
	type cubeKey struct {
		Faces [6][16]float32
		Group uint32
	}
	fastIDs := map[cubeKey]uint32{}
	recipes := &textureRecipes{
		manifest: texturepack.Manifest{Textures: map[string][4]float32{}},
		ids:      map[string]int{},
	}
	shapeIDs := map[string]uint32{}
	var fast []float32
	// 引用按模型连续存放，记录按内容去重；同一面在不同状态组合里只保存一份记录。
	var references []quadReference
	var surfaces []quadRecord
	recordIDs := map[quadRecord]uint32{}
	for _, state := range slices.Sorted(java.JavaFullStates()) {
		name := string(state)
		short := state.ShortName()
		switch short {
		case "air", "cave_air", "void_air", "barrier", "light", "structure_void":
			states[name] = 0
			continue
		}
		m := cubes[name]
		if m.Textures[0][9] > 0 {
			var cubeQuads []geometry.Quad
			for _, sourceID := range tables.Index[state.Hash()] {
				if full, ok := tables.FullHeight[sourceID]; ok {
					sourceID = full
				}
				cubeQuads = append(cubeQuads, tables.Shapes[sourceID].Quads...)
			}
			encodedFaces := recipes.cube(m, cubeQuads)
			key := cubeKey{Faces: encodedFaces, Group: m.Group}
			id, ok := fastIDs[key]
			if !ok {
				id = uint32(len(catalog.Models))
				fastIDs[key] = id
				model := r2assets.Model{
					Kind:   1,
					Offset: uint32(len(fast) / 4),
					Count:  6,
					Group:  m.Group,
				}
				for _, encoded := range encodedFaces {
					fast = append(fast, encoded[:]...)
				}
				catalog.Models = append(catalog.Models, model)
			}
			states[name] = id
			catalog.Statistics["cubeStates"]++
			continue
		}
		ids := tables.Index[state.Hash()]
		if len(ids) == 0 {
			catalog.Unsupported = append(catalog.Unsupported, name)
			continue
		}
		key := fmt.Sprint(ids)
		if id, ok := shapeIDs[key]; ok {
			states[name] = id
			catalog.Statistics["modelStates"]++
			continue
		}
		var quads []geometry.Quad
		for _, id := range ids {
			quads = append(quads, tables.Shapes[id].Quads...)
		}
		if len(quads) == 0 {
			catalog.Unsupported = append(catalog.Unsupported, name)
			continue
		}
		lo := [3]float64{math.Inf(1), math.Inf(1), math.Inf(1)}
		hi := [3]float64{math.Inf(-1), math.Inf(-1), math.Inf(-1)}
		for _, q := range quads {
			for _, p := range q.Positions {
				for a := range 3 {
					lo[a] = min(lo[a], p[a])
					hi[a] = max(hi[a], p[a])
				}
			}
		}
		var minimum, maximum [3]int
		for a := range 3 {
			minimum[a] = int(math.Floor(lo[a] + 1e-8))
			maximum[a] = max(minimum[a], int(math.Ceil(hi[a]-1e-8))-1)
		}
		id := uint32(len(catalog.Models))
		shapeIDs[key] = id
		catalog.Models = append(catalog.Models, r2assets.Model{Kind: 2})
		// 原表面登记到它伸进的每个格子，顶点平移到该格子的局部坐标；着色器只接受落在本格射线区间内的交点。
		for z := minimum[2]; z <= maximum[2]; z++ {
			for y := minimum[1]; y <= maximum[1]; y++ {
				for x := minimum[0]; x <= maximum[0]; x++ {
					offset := [3]int{x, y, z}
					piece := r2assets.Model{Kind: 2, Offset: uint32(len(references))}
					for _, q := range quads {
						if !overlapsCell(q, offset) {
							continue
						}
						reference, record := encodeQuad(q, offset)
						recordID, exists := recordIDs[record]
						if !exists {
							recordID = uint32(len(surfaces))
							recordIDs[record] = recordID
							surfaces = append(surfaces, record)
							recipes.registerTexture(q)
							recipes.manifest.Quads = append(recipes.manifest.Quads, q.Surface.Texture)
						}
						reference[2] = recordID
						references = append(references, reference)
						piece.Count++
					}
					if offset == [3]int{} {
						piece.Fragments = catalog.Models[id].Fragments
						catalog.Models[id] = piece
					} else if piece.Count > 0 {
						pieceID := uint32(len(catalog.Models))
						catalog.Models = append(catalog.Models, piece)
						catalog.Models[id].Fragments = append(catalog.Models[id].Fragments, r2assets.Fragment{Offset: offset, Model: pieceID})
					}
					catalog.Statistics["maxCellQuads"] = max(catalog.Statistics["maxCellQuads"], int(piece.Count))
				}
			}
		}
		if len(catalog.Models[id].Fragments) > 0 {
			catalog.Statistics["splitModels"]++
		}
		catalog.Statistics["maxSourceQuads"] = max(catalog.Statistics["maxSourceQuads"], len(quads))
		states[name] = id
		catalog.Statistics["modelStates"]++
	}
	catalog.Statistics["quadReferences"] = len(references)
	catalog.Statistics["quadRecords"] = len(surfaces)
	catalog.Statistics["models"] = len(catalog.Models)
	catalog.Statistics["cubeModels"] = len(fastIDs)
	catalog.Statistics["unsupportedStates"] = len(catalog.Unsupported)
	var headers []uint32
	for _, model := range catalog.Models {
		headers = append(headers, model.Kind, model.Offset, model.Count, model.Group)
	}
	for name, data := range map[string]any{
		"headers.bin":         headers,
		"fast.bin":            fast,
		"quad-references.bin": references,
		"quad-records.bin":    surfaces,
	} {
		f, err := os.Create("assets/" + name)
		if err != nil {
			return err
		}
		err = binary.Write(f, binary.LittleEndian, data)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	layers := 0
	for i := 0; i < len(fast); i += 16 {
		layers = max(layers, int(fast[i+6])+1)
	}
	catalog.Statistics["surfaceLayers"] = layers

	table, err := stateTable(states)
	if err != nil {
		return err
	}
	if err = os.WriteFile("assets/states.bin", modeldata.EncodeStates(table), 0644); err != nil {
		return err
	}
	catalog.Statistics["stateHashes"] = len(table)
	catalog.Water = states[`minecraft:water ["level"="0"]`]
	encoded, err := json.Marshal(catalog)
	if err != nil {
		return err
	}
	if err = os.WriteFile("assets/catalog.json", encoded, 0644); err != nil {
		return err
	}
	manifest, err := json.Marshal(recipes.manifest)
	if err != nil {
		return err
	}
	if err = os.WriteFile("assets/textures.json", manifest, 0644); err != nil {
		return err
	}
	baseAtlas, err := os.ReadFile("sourceassets/atlas.png")
	if err != nil {
		return err
	}
	if err = os.WriteFile("assets/base-atlas.png", baseAtlas, 0644); err != nil {
		return err
	}
	// 原始表供每次换包重新推导，避免继承上一包的透明分类和图集区域。
	for _, name := range []string{"catalog.json", "fast.bin", "quad-records.bin"} {
		data, err := os.ReadFile("assets/" + name)
		if err != nil {
			return err
		}
		if err = os.WriteFile("assets/base-"+name, data, 0644); err != nil {
			return err
		}
	}
	set, err := texturepack.Build(os.DirFS("assets"), nil, 128)
	if err != nil {
		return err
	}
	for name, data := range set.Files {
		if err = os.WriteFile("assets/"+name, data, 0644); err != nil {
			return err
		}
	}

	summary, err := json.MarshalIndent(catalog.Statistics, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(summary))
	for _, name := range []string{"oak_fence", "fire", "dandelion", "quartz_bricks"} {
		for state, id := range states {
			if strings.HasPrefix(state, "minecraft:"+name+" ") {
				fmt.Println(state, id, catalog.Models[id])
				break
			}
		}
	}
	return nil
}
