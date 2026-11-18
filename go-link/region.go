package r2link

import (
	"encoding/binary"
	"math/bits"
	"slices"
	"sync"

	"neomega-blocks/ir"
)

// RegionMagic 标识区域编码（"TLP4"）。
const RegionMagic = 0x34504c54

// Subchunk 是 16×16×16 方块的子区块：调色板为方块哈希，索引低位在前、不跨字。
// 第 i 个索引对应格子 x = i >> 8, z = (i >> 4) & 15, y = i & 15。Bits 为 0 时整块是 Palette[0]，Words 为空。
type Subchunk struct {
	// Position 是子区块坐标，即方块坐标除以 16 向下取整。
	Position [3]int
	Bits     uint32
	Palette  []uint32
	Words    []uint32
}

// R2Region 汇集横向 8×8 个区块（chunk）的子区块。只发送 Y 索引 -4～27 的子区块，越界数量记入 Clipped。
type R2Region struct {
	Sections []Subchunk
	Clipped  int
}

// Section 和 Region 保留已有 Go 调用方使用的类型名。
type Section = Subchunk
type Region = R2Region

// EncodeRegion 将一个 r2region 的子区块写成小端 u32 数组：magic、子区块数，再逐个写
// sx, sy, sz, bits, 调色板项数, 索引字数, 调色板, 索引。
func EncodeRegion(sections []Subchunk) []byte {
	size := 2
	for _, section := range sections {
		size += 6 + len(section.Palette) + len(section.Words)
	}
	data := make([]byte, 0, size*4)
	put := func(v uint32) { data = binary.LittleEndian.AppendUint32(data, v) }
	put(RegionMagic)
	put(uint32(len(sections)))
	for _, section := range sections {
		put(uint32(int32(section.Position[0])))
		put(uint32(int32(section.Position[1])))
		put(uint32(int32(section.Position[2])))
		put(section.Bits)
		put(uint32(len(section.Palette)))
		put(uint32(len(section.Words)))
		for _, v := range section.Palette {
			put(v)
		}
		for _, v := range section.Words {
			put(v)
		}
	}
	return data
}

// Pack 把 4096 个方块哈希压成子区块：调色板按首次出现排序，位宽取最小值。
func Pack(position [3]int, blocks *[4096]uint32) Subchunk {
	index := map[uint32]uint32{}
	section := Subchunk{Position: position}
	for _, hash := range blocks {
		if _, ok := index[hash]; !ok {
			index[hash] = uint32(len(section.Palette))
			section.Palette = append(section.Palette, hash)
		}
	}
	section.Bits = uint32(bits.Len(uint(len(section.Palette) - 1)))
	if section.Bits == 0 {
		return section
	}
	per := 32 / section.Bits
	section.Words = make([]uint32, (4096+per-1)/per)
	for i, hash := range blocks {
		section.Words[uint32(i)/per] |= index[hash] << (uint32(i) % per * section.Bits)
	}
	return section
}

// 同一世界反复出现的状态只计算一次哈希；状态集合有限，缓存不会无限增长。
var hashes sync.Map

// BlockHash 返回 Java 方块状态的 neomega-blocks 哈希，例如 `minecraft:oak_log ["axis"="y"]`。
func BlockHash(state ir.IRBlock) uint32 {
	if value, ok := hashes.Load(state); ok {
		return value.(uint32)
	}
	value := state.Hash()
	hashes.Store(state, value)
	return value
}

var airHashes = map[uint32]bool{
	ir.IRBlock("minecraft:air []").Hash():      true,
	ir.IRBlock("minecraft:cave_air []").Hash(): true,
	ir.IRBlock("minecraft:void_air []").Hash(): true,
}

// AirHash 是 minecraft:air 的哈希。
var AirHash = ir.IRBlock("minecraft:air []").Hash()

// IsAir 判断哈希是否为空气、洞穴空气或虚空空气；全是空气的 section 不必发送。
func IsAir(hash uint32) bool {
	return airHashes[hash]
}

// ChunkIndex 记录哪些区块存在，按 32×32 区块分组成位图，供地图显示世界分布。
type ChunkIndex map[[2]int][128]byte

// Add 登记区块 (x, z)。
func (index ChunkIndex) Add(x, z int) {
	group := [2]int{x >> 5, z >> 5}
	bitmap := index[group]
	i := (z&31)*32 + (x & 31)
	bitmap[i>>3] |= 1 << (i & 7)
	index[group] = bitmap
}

// Encode 每组写 136 字节：组坐标 int32 x、z，再写 1024 位位图，第 (z&31)*32 + (x&31) 位表示区块存在，低位在前。
func (index ChunkIndex) Encode() []byte {
	groups := make([][2]int, 0, len(index))
	for group := range index {
		groups = append(groups, group)
	}
	slices.SortFunc(groups, func(a, b [2]int) int {
		if a[0] != b[0] {
			return a[0] - b[0]
		}
		return a[1] - b[1]
	})
	data := make([]byte, len(groups)*136)
	for i, group := range groups {
		offset := i * 136
		binary.LittleEndian.PutUint32(data[offset:], uint32(int32(group[0])))
		binary.LittleEndian.PutUint32(data[offset+4:], uint32(int32(group[1])))
		bitmap := index[group]
		copy(data[offset+8:], bitmap[:])
	}
	return data
}
