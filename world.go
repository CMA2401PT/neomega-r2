package r2

import (
	"celler"
	"celler/java"
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"neomega-blocks/ir"
	blocks "neomega-blocks/presets/java/v1"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// World 提供只读 Java 存档的调色板传输；锁仅保护文件句柄，解压与状态映射可并发。
type World struct {
	source  *java.World
	mu      sync.Mutex
	mapping map[string][2]uint32
}

// OpenWorld 预先建立状态映射，区域请求仅转换调色板条目；目前只发布方块本体，含水附加层尚未接入。
func OpenWorld(path string, catalog *Catalog) (*World, error) {
	source, err := java.OpenDirectory(path, java.Options{ReadOnly: true, MaxOpenRegions: 16})
	if err != nil {
		return nil, err
	}
	mapping := make(map[string][2]uint32)
	for state := range blocks.JavaCompatibleStates() {
		normalized, ok := blocks.NormalizeSingleLayer(state)
		if !ok {
			continue
		}
		near, ok := catalog.States[string(normalized)]
		if !ok {
			continue
		}
		ids := [2]uint32{near, catalog.FarStates[string(normalized)]}
		mapping[string(state)] = ids
		for _, value := range []string{"false", "true"} {
			variant := ir.IRBlock(state.NameWithNameSpace() + " " + string(state.States().Set("waterlogged", value))).Tidy()
			mapping[string(variant)] = ids
		}
	}
	return &World{source: source, mapping: mapping}, nil
}
func (w *World) Close() error { return w.source.Close() }

// Region 返回 8×8 区块列的压缩索引，调色板同时携带近景与远景模型编号。
// 坐标、位宽、调色板长度和压缩字长度均为小端 uint32；坐标按 int32 解释。
func (w *World) Region(rx, rz int) ([]byte, error) {
	words := []uint32{0x32504c54, 0, 0}
	for x := rx * 8; x < (rx+1)*8; x++ {
		for z := rz * 8; z < (rz+1)*8; z++ {
			w.mu.Lock()
			record, err := w.source.ReadRaw(java.Overworld, java.Terrain, celler.ChunkPos{X: int32(x), Z: int32(z)})
			w.mu.Unlock()
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			raw, err := record.Decode()
			if err != nil {
				return nil, err
			}
			chunk, err := java.DecodeChunk(raw)
			if err != nil {
				return nil, err
			}
			ys, err := chunk.SectionYs()
			if err != nil {
				return nil, err
			}
			for _, y := range ys {
				if y < -4 || y >= 28 {
					continue
				}
				section, err := chunk.Section(y)
				if err != nil {
					return nil, err
				}
				if section.Blocks == nil {
					continue
				}
				p := section.Blocks
				palette := p.GetUsedPalette()
				mapped := make([]uint32, len(palette)*2)
				nonAir := false
				for i, state := range palette {
					ids, ok := w.mapping[string(state)]
					id := ids[0]
					if !ok {
						words[2]++
					}
					mapped[i*2] = id
					mapped[i*2+1] = ids[1]
					nonAir = nonAir || id != 0
				}
				if !nonAir {
					continue
				}
				words[1]++
				words = append(words, uint32(x), uint32(y), uint32(z), p.Level, uint32(len(palette)), uint32(len(p.Data)))
				words = append(words, mapped...)
				words = append(words, p.Data...)
			}
		}
	}
	data := make([]byte, len(words)*4)
	for i, value := range words {
		binary.LittleEndian.PutUint32(data[i*4:], value)
	}
	return data, nil
}

// ServeRegion 把实际读取时间随响应传给实验页面，客户端另行测量解包、层次构建和上传。
func (w *World) ServeRegion(out http.ResponseWriter, r *http.Request) {
	x, err := strconv.Atoi(r.URL.Query().Get("x"))
	if err != nil {
		http.Error(out, err.Error(), 400)
		return
	}
	z, err := strconv.Atoi(r.URL.Query().Get("z"))
	if err != nil {
		http.Error(out, err.Error(), 400)
		return
	}
	start := time.Now()
	data, err := w.Region(x, z)
	if err != nil {
		http.Error(out, err.Error(), 500)
		return
	}
	out.Header().Set("Content-Type", "application/octet-stream")
	out.Header().Set("Server-Timing", fmt.Sprintf("read;dur=%.3f", float64(time.Since(start).Microseconds())/1000))
	out.Write(data)
}
