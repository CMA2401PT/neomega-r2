// 本例给栅栏东侧放一块石头，用所选版本的实心面表修复连接属性。
//
//go:generate python3 ../../assets-utils/resourcegen/generate.py --java 26.3 --topic java-blocks --topic solid-faces --out generated
package main

import (
	"bytes"
	"flag"
	"fmt"
	"iter"
	"log"
	"os"
	"path/filepath"

	"neomega-blocks/blockconv"
	"neomega-blocks/ir"
	fixer "neomega-view-utils/fixer/java-postprocess"
	"neomega-view-utils/fixer/solidtable"
)

func main() {
	dir := flag.String("resources", "generated/26.3", "包含 java-blocks 和 solid-faces 的版本目录")
	flag.Parse()
	read := func(name string) []byte {
		data, err := os.ReadFile(filepath.Join(*dir, name))
		if err != nil {
			log.Fatal(err)
		}
		return data
	}
	// 每个方块状态有六个实心位。栅栏查询东邻的西面，决定是否伸出东侧连接。
	solid, err := solidtable.Decode(bytes.NewReader(read("solid-faces/solid-faces.nvsolid")))
	if err != nil {
		log.Fatal(err)
	}
	// 状态表识别含水和历史状态，属性域与默认属性用来补全本例省略的栅栏属性。
	states := blockconv.NewWaterloggedStates(
		read("java-blocks/java_states.list"),
		read("java-blocks/java_compatibility.list"),
	)
	schema := blockconv.NewSchema(read("java-blocks/java_block_schema.list"))
	defaults, err := blockconv.NewCanonBlock[ir.IRBlock](read("java-blocks/java_default_properties.json"))
	if err != nil {
		log.Fatal(err)
	}
	repair := fixer.New(solid, schema, states, defaults)
	fence := [3]int{0, 0, 0}
	east := [3]int{1, 0, 0}
	world := map[[3]int]ir.IRBlock{
		fence: "minecraft:oak_fence []",
		east:  "minecraft:stone []",
	}
	// 只修复原点这一格，所以 X、Z 的上界都是 1（不含）。Get 仍可以读取东邻。
	changes := repair.Fix(fixer.Input{
		Bounds: fixer.HorizontalBounds{Max: [2]int{1, 1}},
		Blocks: func(accept func(ir.IRBlock) bool) iter.Seq2[[3]int, ir.IRBlock] {
			return func(yield func([3]int, ir.IRBlock) bool) {
				if accept(world[fence]) {
					yield(fence, world[fence])
				}
			}
		},
		Get: func(x, y, z int) (ir.IRBlock, bool) {
			block, ok := world[[3]int{x, y, z}]
			if !ok {
				return "minecraft:air []", false
			}
			return block, true
		},
	})
	// Fix 返回变化，宿主决定何时把结果写回自己的世界。
	fmt.Println("修复前", world[fence])
	for pos, state := range changes {
		world[pos] = state
	}
	fmt.Println("修复后", world[fence])
}
