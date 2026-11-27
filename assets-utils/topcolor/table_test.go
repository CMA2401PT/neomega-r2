package topcolor

import (
	"bytes"
	"maps"
	"testing"

	"neomega-blocks/ir"
)

func TestWireFormat(t *testing.T) {
	// 独立字节样本同时固定小端布局、记录顺序和颜色的低 24 位表示。
	wire := []byte{
		'N', 'V', 'C', 'L', 1, 0, 0, 0, 2, 0, 0, 0,
		4, 3, 2, 1, 0x56, 0x34, 0x12, 0,
		8, 7, 6, 5, 0xef, 0xcd, 0xab, 0,
	}
	want := Table{0x05060708: 0xabcdef, 0x01020304: 0x123456}
	var first, second bytes.Buffer
	if err := want.Encode(&first); err != nil {
		t.Fatal(err)
	}
	if err := want.Encode(&second); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Bytes(), wire) || !bytes.Equal(first.Bytes(), second.Bytes()) {
		t.Fatalf("unstable or incorrect encoding: %x; %x", first.Bytes(), second.Bytes())
	}
	got, err := Decode(bytes.NewReader(first.Bytes()))
	if err != nil || !maps.Equal(got, want) {
		t.Fatalf("decoded %v, error %v; want %v", got, err, want)
	}
	for _, offset := range []int{0, 4} {
		invalid := bytes.Clone(wire)
		invalid[offset]++
		if _, err := Decode(bytes.NewReader(invalid)); err == nil {
			t.Fatalf("accepted invalid header at byte %d", offset)
		}
	}
}

func TestColorNormalizesWaterlogged(t *testing.T) {
	// 表只存目标状态，含水属性不应增加颜色记录。
	stone := ir.IRBlock("minecraft:stone []").Tidy()
	table := Table{stone.Hash(): 0x123456}
	for _, text := range []string{
		"minecraft:stone []",
		`minecraft:stone ["waterlogged"="true"]`,
		`minecraft:stone ["waterlogged"="false"]`,
	} {
		got, ok := table.Color(ir.IRBlock(text).Tidy())
		if !ok || got != 0x123456 {
			t.Fatalf("%s: got %#06x, %v; want 0x123456, true", text, got, ok)
		}
	}
}
