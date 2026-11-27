package r2assets

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bufio"
	"neomega-blocks/ir"
	geometry "neomega-view-utils/r2assets/geometry"
)

// 楼梯完整落在一格内。每种朝向、转角和上下半部都应保留源模型的全部面。
func TestGeneratedStairsKeepAllFaces(t *testing.T) {
	file, err := os.Open(generatedFile(t, "block-geometry/block-geometry.nvtables"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	source, err := geometry.DecodeTables[uint32](file)
	if err != nil {
		t.Fatal(err)
	}
	states, err := archive(t).OpenStates()
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := archive(t).OpenCatalog()
	if err != nil {
		t.Fatal(err)
	}
	statesFile, err := os.Open(generatedFile(t, "java-blocks/java_states.list"))
	if err != nil {
		t.Fatal(err)
	}
	defer statesFile.Close()
	scanner := bufio.NewScanner(statesFile)
	for scanner.Scan() {
		state := ir.IRBlock(scanner.Text())
		if !strings.HasSuffix(state.ShortName(), "_stairs") {
			continue
		}
		hash := state.Hash()
		want := 0
		for _, shape := range source.Index[hash] {
			want += len(source.Shapes[shape].Quads)
		}
		model := catalog.Models[states[hash]]
		if want == 0 || int(model.Count) != want || len(model.Fragments) != 0 {
			t.Fatalf("%s：源模型有 %d 个面，生成后本格有 %d 个面，另有 %d 个跨格片段", state, want, model.Count, len(model.Fragments))
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
}

// 每个格子登记的表面都必须与该格相交，否则射线在这一格永远命中不到它，说明登记表错位。
func TestGeneratedQuadsTouchTheirCell(t *testing.T) {
	references, err := archive(t).ReadFile("assets/quad-references.bin")
	if err != nil {
		t.Fatal(err)
	}
	records, err := archive(t).ReadFile("assets/quad-records.bin")
	if err != nil {
		t.Fatal(err)
	}
	word := func(data []byte, index int) uint32 { return binary.LittleEndian.Uint32(data[index*4:]) }
	float := func(index int) float64 { return float64(math.Float32frombits(word(records, index))) }
	for i := 0; i < len(references)/16; i++ {
		record := int(word(references, i*4+2)) * 28
		if record+28 > len(records)/4 {
			t.Fatalf("引用 %d 指向不存在的记录", i)
		}
		// 格子中心到平面的距离不超过半条对角线，平面才可能穿过格子。
		d := float64(math.Float32frombits(word(references, i*4+1)))
		packed := word(references, i*4)
		n := [3]float64{float64(int16(uint16(packed))) / 32767, float64(int16(uint16(packed>>16))) / 32767, 0}
		n[2] = 1 - math.Abs(n[0]) - math.Abs(n[1])
		if n[2] < 0 {
			x, y := n[0], n[1]
			n[0] = x - math.Copysign(-n[2], x)
			n[1] = y - math.Copysign(-n[2], y)
		}
		length := math.Sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2])
		center := (n[0]*.5 + n[1]*.5 + n[2]*.5) / length
		if math.IsNaN(d) || math.Abs(center-d) > math.Sqrt(3)/2+1e-4 || math.IsNaN(float(record)) {
			t.Fatalf("引用 %d 的平面没有穿过格子：d=%g", i, d)
		}
	}
}

// 数据源发送的是方块哈希：规范状态、兼容旧状态和含水变体都应查到同一个模型，水源对应目录中的水。
func TestStatesByHash(t *testing.T) {
	states, err := archive(t).OpenStates()
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := archive(t).OpenCatalog()
	if err != nil {
		t.Fatal(err)
	}
	model := func(state string) uint32 {
		t.Helper()
		id, ok := states[ir.IRBlock(state).Hash()]
		if !ok {
			t.Fatalf("状态表缺少 %s", state)
		}
		return id
	}
	if model("minecraft:air []") != 0 || model("minecraft:stone []") == 0 {
		t.Fatal("空气或石头的模型错误")
	}
	if model(`minecraft:water ["level"="0"]`) != catalog.Water || catalog.Water == 0 {
		t.Fatal("水源模型与目录不一致", catalog.Water)
	}
	stairs := `minecraft:oak_stairs ["facing"="north","half"="bottom","shape"="straight","waterlogged"="false"]`
	if model(stairs) != model(`minecraft:oak_stairs ["facing"="north","half"="bottom","shape"="straight","waterlogged"="true"]`) {
		t.Fatal("含水变体应共用方块本体模型")
	}
}

func archive(t *testing.T) *Archive {
	t.Helper()
	data, err := os.ReadFile(generatedFile(t, "browser-materials/default-materials.zip"))
	if err != nil {
		t.Fatal(err)
	}
	a, err := OpenArchive(data)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// 成套资源的回归测试读取调用方选择的生成结果。
func generatedFile(t *testing.T, path string) string {
	t.Helper()
	dir := os.Getenv("R2_GENERATED")
	if dir == "" {
		t.Skip("设置 R2_GENERATED 指向指定版本的生成目录以运行真实资源测试")
	}
	return filepath.Join(dir, path)
}
