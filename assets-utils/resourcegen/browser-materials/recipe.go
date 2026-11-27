// Package browsermaterials 将单层状态和几何编译为浏览器绘制与替换纹理使用的模型配方。
package browsermaterials

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	cubematerials "neomega-view-utils/r2assets/resourcegen/cube-materials"
	"os"
	"path/filepath"
	"slices"

	"neomega-blocks/blockconv"
	geometry "neomega-view-utils/r2assets/geometry"
	"neomega-view-utils/r2assets/internal/modeldata"
)

// WriteRecipe 生成两种浏览器归档共用的模型和贴图配方。
func WriteRecipe(java *blockconv.WaterloggedStates, tables *geometry.Tables[uint32], cubes map[uint32]cubematerials.Material, output string) error {
	states := map[string]uint32{}
	catalog := modeldata.Catalog{
		Models:     []modeldata.Model{{}},
		Statistics: map[string]int{},
	}
	type cubeKey struct {
		Faces [6][16]float32
		Group uint32
	}
	fastIDs := map[cubeKey]uint32{}
	recipes := &textureRecipes{
		manifest: Manifest{Textures: map[string][4]float32{}},
		ids:      map[string]int{},
	}
	shapeIDs := map[string]uint32{}
	var fast []float32
	// 引用按模型连续存放，记录按内容去重；同一面在不同状态组合里只保存一份记录。
	var references []quadReference
	var surfaces []quadRecord
	recordIDs := map[quadRecord]uint32{}
	for _, state := range slices.Sorted(java.NativeStates()) {
		name := string(state)
		short := state.ShortName()
		switch short {
		case "air", "cave_air", "void_air", "barrier", "light", "structure_void":
			states[name] = 0
			continue
		}
		if m, ok := cubes[state.Hash()]; ok {
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
				model := modeldata.Model{
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
		snapToCellBoundaries(quads)
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
			minimum[a] = int(math.Floor(lo[a]))
			maximum[a] = max(minimum[a], int(math.Ceil(hi[a]))-1)
		}
		id := uint32(len(catalog.Models))
		shapeIDs[key] = id
		catalog.Models = append(catalog.Models, modeldata.Model{Kind: 2})
		// 原表面登记到它伸进的每个格子，顶点平移到该格子的局部坐标；着色器只接受落在本格射线区间内的交点。
		for z := minimum[2]; z <= maximum[2]; z++ {
			for y := minimum[1]; y <= maximum[1]; y++ {
				for x := minimum[0]; x <= maximum[0]; x++ {
					offset := [3]int{x, y, z}
					piece := modeldata.Model{Kind: 2, Offset: uint32(len(references))}
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
						catalog.Models[id].Fragments = append(catalog.Models[id].Fragments, modeldata.Fragment{Offset: offset, Model: pieceID})
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
	for name, data := range map[string]any{
		"base-fast.bin":         fast,
		"quad-references.bin":   references,
		"base-quad-records.bin": surfaces,
	} {
		f, err := os.Create(filepath.Join(output, name))
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

	table, err := stateTable(java, states)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(output, "states.bin"), modeldata.EncodeStates(table), 0644); err != nil {
		return err
	}
	catalog.Statistics["stateHashes"] = len(table)
	catalog.Water = states[`minecraft:water ["level"="0"]`]
	encoded, err := json.Marshal(catalog)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(output, "base-catalog.json"), encoded, 0644); err != nil {
		return err
	}
	manifest, err := json.Marshal(recipes.manifest)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(output, "textures.json"), manifest, 0644); err != nil {
		return err
	}
	return nil
}
