package r2

import (
	"encoding/binary"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Grid 每格保存本格模型及附加片段列表的索引，射线只访问当前格。
type Grid struct {
	Parts []uint32 `json:"parts"`
	Size  [3]int   `json:"size"`
	Cells []uint32 `json:"-"`
}

func NewGrid(size [3]int) *Grid {
	return &Grid{Size: size, Cells: make([]uint32, size[0]*size[1]*size[2]*2)}
}
func (g *Grid) index(p [3]int) int         { return (p[0] + g.Size[0]*(p[1]+g.Size[1]*p[2])) * 2 }
func (g *Grid) Set(p [3]int, model uint32) { g.Cells[g.index(p)] = model }

// PlaceFragments 将预裁切片段的索引分发到各格，模型形状、UV 和裁切结果不在加载时计算。
func (g *Grid) PlaceFragments(catalog *Catalog) int {
	lists := map[int][]uint32{}
	refs := 0
	for z := range g.Size[2] {
		for y := range g.Size[1] {
			for x := range g.Size[0] {
				owner := [3]int{x, y, z}
				id := g.Cells[g.index(owner)]
				if id == 0 {
					continue
				}
				for _, part := range catalog.Models[id].Fragments {
					p := [3]int{x + part.Offset[0], y + part.Offset[1], z + part.Offset[2]}
					if p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= g.Size[0] || p[1] >= g.Size[1] || p[2] >= g.Size[2] {
						continue
					}
					index := g.index(p)
					lists[index] = append(lists[index], part.Model)
					refs++
				}
			}
		}
	}
	// 先写长度再写片段编号；零索引表示没有附加片段。
	g.Parts = []uint32{0}
	for index := 0; index < len(g.Cells); index += 2 {
		if parts := lists[index]; len(parts) > 0 {
			g.Cells[index+1] = uint32(len(g.Parts))
			g.Parts = append(g.Parts, uint32(len(parts)))
			g.Parts = append(g.Parts, parts...)
		}
	}
	return refs
}

func (g *Grid) Bytes() []byte {
	output := make([]byte, len(g.Cells)*4)
	for i, v := range g.Cells {
		binary.LittleEndian.PutUint32(output[i*4:], v)
	}
	return output
}

type Scene struct {
	Grid               *Grid             `json:"grid"`
	Camera             [3]float64        `json:"camera"`
	Target             [3]float64        `json:"target"`
	BuildMS            float64           `json:"buildMS"`
	NonAir             int               `json:"nonAir"`
	FragmentReferences int               `json:"fragmentReferences"`
	Names              map[string]uint32 `json:"names"`
}

// BuildScene 建立可复现的独立输入；所有模式只查表填编号，模型表不随场景重新生成。
func BuildScene(catalog *Catalog, name string) (*Scene, error) {
	start := time.Now()
	scene := &Scene{Grid: NewGrid([3]int{64, 32, 64}), Camera: [3]float64{32, 16, 58}, Target: [3]float64{32, 3, 25}, Names: map[string]uint32{}}
	states := make([]string, 0, len(catalog.States))
	for state := range catalog.States {
		states = append(states, state)
	}
	slices.Sort(states)
	find := func(short string, properties ...string) uint32 {
		for _, state := range states {
			if !strings.HasPrefix(state, "minecraft:"+short+" ") {
				continue
			}
			match := true
			for _, property := range properties {
				if !strings.Contains(state, property) {
					match = false
				}
			}
			if match {
				id := catalog.States[state]
				scene.Names[state] = id
				return id
			}
		}
		panic("资源中没有场景方块：" + short)
	}
	stone, grass, quartz := find("stone"), find("grass_block", `"snowy"="false"`), find("quartz_bricks")
	fence := find("oak_fence", `"north"="true"`, `"south"="true"`, `"east"="true"`, `"west"="true"`)
	flower, fire := find("dandelion"), find("fire", `"age"="0"`, `"east"="false"`, `"north"="false"`, `"south"="false"`, `"west"="false"`, `"up"="false"`)
	stairs := find("quartz_stairs", `"facing"="east"`, `"half"="bottom"`, `"shape"="straight"`)
	glass, water, leaves := find("glass"), find("water", `"level"="0"`), find("oak_leaves")
	g := scene.Grid
	for z := range 64 {
		for x := range 64 {
			g.Set([3]int{x, 0, z}, stone)
			g.Set([3]int{x, 1, z}, grass)
		}
	}
	switch name {
	case "showcase":
		models := []uint32{quartz, fence, flower, fire, stairs, glass, water, leaves}
		for i, id := range models {
			for z := 14; z < 24; z += 3 {
				for x := 5 + i*7; x < 9+i*7; x++ {
					g.Set([3]int{x, 2, z}, id)
				}
			}
		}
		for z := 28; z < 42; z++ {
			for x := 10; x < 26; x++ {
				if (x+z)%3 == 0 {
					g.Set([3]int{x, 2, z}, flower)
				}
			}
		}
		for z := 28; z < 42; z++ {
			for x := 34; x < 50; x++ {
				if (x+z)%2 == 0 {
					g.Set([3]int{x, 2, z}, fence)
				}
			}
		}
	case "fences", "cutouts", "cubes":
		id := fence
		if name == "cutouts" {
			id = flower
		}
		if name == "cubes" {
			id = quartz
		}
		for z := 8; z < 48; z++ {
			for x := 8; x < 56; x++ {
				g.Set([3]int{x, 2, z}, id)
			}
		}
	case "glass8", "glass16":
		depth := 8
		if name == "glass16" {
			depth = 16
		}
		for z := 24; z < 24+depth; z++ {
			for y := 2; y < 14; y++ {
				for x := 20; x < 44; x++ {
					g.Set([3]int{x, y, z}, glass)
				}
			}
		}
		scene.Camera = [3]float64{32, 8, 52}
		scene.Target = [3]float64{32, 8, 28}
	case "spill":
		var id uint32
		for _, state := range states {
			candidate := catalog.States[state]
			if strings.HasPrefix(state, "minecraft:fire ") && len(catalog.Models[candidate].Fragments) > 0 {
				id = candidate
				scene.Names[state] = id
				break
			}
		}
		if id == 0 {
			return nil, fmt.Errorf("没有可测试的跨格模型")
		}
		for x := 24; x < 40; x += 2 {
			g.Set([3]int{x, 2, 26}, id)
		}
		scene.Camera = [3]float64{32, 4, 31}
		scene.Target = [3]float64{32, 3, 26}
	default:
		return nil, fmt.Errorf("未知场景 %q", name)
	}
	scene.FragmentReferences = g.PlaceFragments(catalog)
	for i := 0; i < len(g.Cells); i += 2 {
		if g.Cells[i] != 0 {
			scene.NonAir++
		}
	}
	scene.BuildMS = float64(time.Since(start).Microseconds()) / 1000
	return scene, nil
}
