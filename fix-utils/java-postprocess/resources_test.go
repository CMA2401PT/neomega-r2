package fixer

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"neomega-blocks/blockconv"
	"neomega-blocks/ir"
	"neomega-view-utils/fixer/solidtable"
)

// 规则用例用石头表示完整方块，用下半砖表示只覆盖底面的方块。
func fixtureFixer() *Fixer {
	solid := solidtable.Table{
		ir.IRBlock("minecraft:stone []").Tidy().Hash():                     0b111111,
		ir.IRBlock(`minecraft:stone_slab ["type"="bottom"]`).Tidy().Hash(): 1 << 2,
	}
	return New(solid, testSchema, testStates, testJavaDefaults)
}

var testStates *blockconv.WaterloggedStates
var testSchema blockconv.Schema
var testJavaDefaults *blockconv.CanonBlock[ir.IRBlock]
var testJavaToBedrock, testBedrockToJava *blockconv.BlockConverter

func mustTable[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
func TestMain(m *testing.M) {
	dir := os.Getenv("NEOMEGA_BLOCK_TABLES")
	if dir == "" {
		os.Exit(m.Run())
	}
	read := func(name string) []byte { return mustTable(os.ReadFile(filepath.Join(dir, name))) }
	testJavaDefaults = mustTable(blockconv.NewCanonBlock[ir.IRBlock](read("java_default_properties.json")))
	// 门的跨版本往返用例还会使用调用方提供的 Bedrock 映射。
	if _, err := os.Stat(filepath.Join(dir, "java_hash_to_bedrock_hash.bin")); !errors.Is(err, os.ErrNotExist) {
		target := mustTable(blockconv.NewHashToBlock[uint32, ir.IRBlock](read("bedrock_hash_to_block.bin")))
		bc := mustTable(blockconv.NewCanonBlock[ir.IRBlock](read("bedrock_default_properties.json")))
		testJavaToBedrock = mustTable(blockconv.NewBlockConverter(read("java_hash_to_bedrock_hash.bin"), testJavaDefaults, target))
		javaTarget := mustTable(blockconv.NewHashToBlock[uint32, ir.IRBlock](read("java_hash_to_block.bin")))
		testBedrockToJava = mustTable(blockconv.NewBlockConverter(read("bedrock_hash_to_java_hash.bin"), bc, javaTarget))
	}
	testStates = blockconv.NewWaterloggedStates(read("java_states.list"), read("java_compatibility.list"))
	testSchema = blockconv.NewSchema(read("java_block_schema.list"))
	os.Exit(m.Run())
}
