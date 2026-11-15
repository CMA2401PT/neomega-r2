package geometry

import (
	"encoding/binary"
	"fmt"
	"io"
	"math/bits"

	"neomega-r2/internal/sourcegeometry/material"
)

const tableMagic = "NVGT"
const tableVersion = 2

type tableHeader struct {
	Magic      [4]byte
	Version    uint16
	BlockWidth uint8
	Reserved   uint8
	Indexes    uint32
	Shapes     uint32
	FullHeight uint32
	Surfaces   uint32
	Vec3s      uint32
	Vec2s      uint32
}

type wireQuad struct {
	// 向量引用保留字典中的 float64 精度，避免改变裁切与合并判定。
	Positions   [4]uint32
	Normal      uint32
	ShadeNormal uint32
	UV          [4]uint32
	Color       [3]float32
	Surface     uint32
	CullFace    CullFace
}

type wireBoundary struct {
	Quad uint32
	Min  Vec2
	Max  Vec2
}

func blockWidth[B BlockID]() uint8 {
	return uint8(bits.Len64(uint64(^B(0))) / 8)
}

func DecodeTables[B BlockID](r io.Reader) (*Tables[B], error) {
	reader := tableReader{r: r}
	var header tableHeader
	reader.read(&header)
	if reader.err != nil {
		return nil, reader.err
	}
	if string(header.Magic[:]) != tableMagic {
		return nil, fmt.Errorf("invalid NVGT magic")
	}
	if header.Version != tableVersion {
		return nil, fmt.Errorf("unsupported NVGT version %d", header.Version)
	}
	if header.BlockWidth != blockWidth[B]() {
		return nil, fmt.Errorf("NVGT block ID width %d does not match requested width %d", header.BlockWidth, blockWidth[B]())
	}
	surfaces := make([]material.Surface, header.Surfaces)
	for i := range surfaces {
		surface := &surfaces[i]
		surface.Texture = reader.text()
		surface.Mode = material.Mode(reader.text())
		reader.read(&surface.Region)
		reader.read(&surface.DoubleSided)
		reader.read(&surface.Unlit)
		reader.read(&surface.Opacity)
		var frames, frameTime uint32
		reader.read(&frames)
		reader.read(&frameTime)
		surface.Frames = int(frames)
		surface.FrameTime = int(frameTime)
	}
	vec3s := make([]Vec3, header.Vec3s)
	vec2s := make([]Vec2, header.Vec2s)
	reader.read(vec3s)
	reader.read(vec2s)
	tables := &Tables[B]{
		Index:      make(map[B][]ModelID, header.Indexes),
		Shapes:     make([]Shape, header.Shapes),
		FullHeight: make(map[ModelID]ModelID, header.FullHeight),
	}
	for range header.Indexes {
		var id B
		if header.BlockWidth == 4 {
			var value uint32
			reader.read(&value)
			id = B(value)
		} else {
			var value uint64
			reader.read(&value)
			id = B(value)
		}
		ids := make([]ModelID, reader.count())
		reader.read(ids)
		tables.Index[id] = ids
	}
	for i := range tables.Shapes {
		shape := &tables.Shapes[i]
		reader.read(&shape.CullGroup)
		shape.Quads = make([]Quad, reader.count())
		for j := range shape.Quads {
			var quad wireQuad
			reader.read(&quad)
			if reader.err != nil {
				return nil, reader.err
			}
			decoded := Quad{
				Normal:      vec3s[quad.Normal],
				ShadeNormal: vec3s[quad.ShadeNormal],
				Color:       quad.Color,
				Surface:     surfaces[quad.Surface],
				CullFace:    quad.CullFace,
			}
			for i, id := range quad.Positions {
				decoded.Positions[i] = vec3s[id]
			}
			for i, id := range quad.UV {
				decoded.UV[i] = vec2s[id]
			}
			shape.Quads[j] = decoded
		}
		for side := range shape.Boundary {
			boundary := make([]BoundaryRect, reader.count())
			for j := range boundary {
				var rect wireBoundary
				reader.read(&rect)
				boundary[j] = BoundaryRect{Quad: int(rect.Quad), Min: rect.Min, Max: rect.Max}
			}
			shape.Boundary[side] = boundary
		}
	}
	for range header.FullHeight {
		var id, full ModelID
		reader.read(&id)
		reader.read(&full)
		tables.FullHeight[id] = full
	}
	if reader.err != nil {
		return nil, reader.err
	}
	return tables, nil
}

type tableReader struct {
	r   io.Reader
	err error
}

func (reader *tableReader) read(value any) {
	if reader.err == nil {
		reader.err = binary.Read(reader.r, binary.LittleEndian, value)
	}
}

func (reader *tableReader) count() uint32 {
	var count uint32
	reader.read(&count)
	return count
}

func (reader *tableReader) text() string {
	data := make([]byte, reader.count())
	if reader.err == nil {
		_, reader.err = io.ReadFull(reader.r, data)
	}
	return string(data)
}
