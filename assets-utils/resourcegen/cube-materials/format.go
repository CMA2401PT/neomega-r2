package cubematerials

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"maps"
	"slices"
)

// Face 对应一个完整边界面，颜色与染色均为 sRGB，透明度独立于代表色。
type Face struct {
	Color   [4]byte
	Tint    [3]float32
	Opacity float32
	Flags   uint32
}

// Material 的六面顺序依次为 -X、+X、-Y、+Y、-Z、+Z。
type Material struct {
	Group uint32
	Faces [6]Face
}
type record struct {
	Hash     uint32
	Material Material
}
type header struct {
	Magic   [4]byte
	Version uint32
	Count   uint32
}

// Encode 按状态哈希升序写固定宽度的小端记录，格式与 Go 类型名称无关。
func Encode(w io.Writer, table map[uint32]Material) error {
	b := bufio.NewWriter(w)
	if err := binary.Write(b, binary.LittleEndian, header{[4]byte{'N', 'V', 'C', 'M'}, 1, uint32(len(table))}); err != nil {
		return err
	}
	for _, hash := range slices.Sorted(maps.Keys(table)) {
		if err := binary.Write(b, binary.LittleEndian, record{hash, table[hash]}); err != nil {
			return err
		}
	}
	return b.Flush()
}

// Decode 读取指定版本的六面材质表。
func Decode(r io.Reader) (map[uint32]Material, error) {
	b := bufio.NewReader(r)
	var h header
	if err := binary.Read(b, binary.LittleEndian, &h); err != nil {
		return nil, err
	}
	if string(h.Magic[:]) != "NVCM" || h.Version != 1 {
		return nil, fmt.Errorf("无法识别六面材质表 %q v%d", h.Magic, h.Version)
	}
	table := make(map[uint32]Material)
	for range h.Count {
		var row record
		if err := binary.Read(b, binary.LittleEndian, &row); err != nil {
			return nil, err
		}
		table[row.Hash] = row.Material
	}
	return table, nil
}
