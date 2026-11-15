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
	r2 "neomega-r2"
	geometry "neomega-r2/internal/sourcegeometry"
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
	catalog := r2.Catalog{States: map[string]uint32{}, Models: []r2.Model{{}}, Statistics: map[string]int{}}
	fastIDs := map[cubeMaterial]uint32{}
	shapeIDs := map[string]uint32{}
	var fast, triangles []float32
	for _, state := range slices.Sorted(java.JavaFullStates()) {
		name := string(state)
		short := state.ShortName()
		switch short {
		case "air", "cave_air", "void_air", "barrier", "light", "structure_void":
			catalog.States[name] = 0
			continue
		}
		m := cubes[name]
		if m.Textures[0][9] > 0 {
			id, ok := fastIDs[m]
			if !ok {
				id = uint32(len(catalog.Models))
				fastIDs[m] = id
				catalog.Models = append(catalog.Models, r2.Model{Kind: 1, Offset: uint32(len(fast) / 4), Count: 6, Group: m.Group})
				for face, values := range m.Textures {
					fast = append(fast, values[:]...)
					for _, c := range m.Faces[face] {
						fast = append(fast, float32(c)/255)
					}
				}
			}
			catalog.States[name] = id
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
			catalog.States[name] = id
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
		lo, hi := [3]float64{math.Inf(1), math.Inf(1), math.Inf(1)}, [3]float64{math.Inf(-1), math.Inf(-1), math.Inf(-1)}
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
		catalog.Models = append(catalog.Models, r2.Model{Kind: 2})
		// 每个片段都裁到单位格子，并把顶点平移到该格子的局部坐标；只裁原表面，不添加封口面。
		for z := minimum[2]; z <= maximum[2]; z++ {
			for y := minimum[1]; y <= maximum[1]; y++ {
				for x := minimum[0]; x <= maximum[0]; x++ {
					offset := [3]int{x, y, z}
					piece := r2.Model{Kind: 2, Offset: uint32(len(triangles) / 4)}
					for _, q := range quads {
						for _, corners := range [][3]int{{0, 1, 2}, {0, 2, 3}} {
							polygon := []vertex{}
							for _, corner := range corners {
								polygon = append(polygon, vertex{Position: q.Positions[corner], UV: q.UV[corner]})
							}
							polygon = clipToCell(polygon, offset)
							for i := 1; i+1 < len(polygon); i++ {
								triangle := [3]vertex{polygon[0], polygon[i], polygon[i+1]}
								if !hasArea(triangle) {
									continue
								}
								triangles = append(triangles, encodeTriangle(q, triangle, offset)...)
								piece.Count++
							}
						}
					}
					if offset == [3]int{} {
						piece.Fragments = catalog.Models[id].Fragments
						catalog.Models[id] = piece
					} else if piece.Count > 0 {
						pieceID := uint32(len(catalog.Models))
						catalog.Models = append(catalog.Models, piece)
						catalog.Models[id].Fragments = append(catalog.Models[id].Fragments, r2.Fragment{Offset: offset, Model: pieceID})
					}
					catalog.Statistics["maxFragmentTriangles"] = max(catalog.Statistics["maxFragmentTriangles"], int(piece.Count))
				}
			}
		}
		if len(catalog.Models[id].Fragments) > 0 {
			catalog.Statistics["splitModels"]++
		}
		catalog.Statistics["maxSourceTriangles"] = max(catalog.Statistics["maxSourceTriangles"], len(quads)*2)
		catalog.States[name] = id
		catalog.Statistics["modelStates"]++
	}
	// 状态组合会复用同一批三角面；全局只保存一次顶点和材质，每个模型保存面索引。
	references := make([]uint32, len(triangles)/32)
	unique := []float32{}
	ids := map[[32]float32]uint32{}
	for i := range references {
		key := [32]float32{}
		copy(key[:], triangles[i*32:(i+1)*32])
		id, exists := ids[key]
		if !exists {
			id = uint32(len(unique) / 32)
			ids[key] = id
			unique = append(unique, key[:]...)
		}
		references[i] = id
	}
	triangles = unique
	for i := range catalog.Models {
		if catalog.Models[i].Kind == 2 {
			catalog.Models[i].Offset /= 8
		}
	}
	catalog.Statistics["triangleReferences"] = len(references)
	catalog.Statistics["models"] = len(catalog.Models)
	catalog.Statistics["cubeModels"] = len(fastIDs)
	catalog.Statistics["triangles"] = len(triangles) / 32
	catalog.Statistics["unsupportedStates"] = len(catalog.Unsupported)
	var headers []uint32
	for _, model := range catalog.Models {
		headers = append(headers, model.Kind, model.Offset, model.Count, model.Group)
	}
	for name, data := range map[string]any{"headers.bin": headers, "fast.bin": fast, "triangles.bin": triangles, "triangle-ids.bin": references} {
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
	encoded, err := json.Marshal(catalog)
	if err != nil {
		return err
	}
	if err = os.WriteFile("assets/catalog.json", encoded, 0644); err != nil {
		return err
	}
	summary, err := json.MarshalIndent(catalog.Statistics, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(summary))
	for _, name := range []string{"oak_fence", "fire", "dandelion", "quartz_bricks"} {
		for state, id := range catalog.States {
			if strings.HasPrefix(state, "minecraft:"+name+" ") {
				fmt.Println(state, id, catalog.Models[id])
				break
			}
		}
	}
	return nil
}
