package r2link

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// testSource 的区域 (x, z) 是一个 section，整块为哈希 x*100+z+1；区域 (9, 9) 阻塞到取消，区域 (7, 7) 读取失败。
type testSource struct {
	mu      sync.Mutex
	version uint32
	reads   map[RegionPos]int
	blocked chan struct{}
}

func (s *testSource) Region(ctx context.Context, x, z int) (Region, error) {
	s.mu.Lock()
	s.reads[RegionPos{x, z}]++
	version := s.version
	s.mu.Unlock()
	switch {
	case x == 9 && z == 9:
		<-ctx.Done()
		close(s.blocked)
		return Region{}, ctx.Err()
	case x == 7 && z == 7:
		return Region{}, errTest
	case x == 5:
		return Region{}, nil
	}
	return Region{Sections: []Section{{Position: [3]int{x * 8, 0, z * 8}, Palette: []uint32{uint32(x*100+z+1) + version}}}, Clipped: 2}, nil
}

func (s *testSource) BlockEntities(ctx context.Context, x, z int, center [3]int, radius int) ([]BlockEntity, error) {
	return []BlockEntity{{SNBT: "{test:1b}", Position: [3]int{center[0], radius, 0}}}, nil
}

func (s *testSource) Chunks(ctx context.Context) (ChunkIndex, error) {
	index := ChunkIndex{}
	index.Add(-1, 33)
	return index, nil
}

type testError string

func (e testError) Error() string { return string(e) }

const errTest = testError("读不到")

func start(t *testing.T, source Source, options Options) (*Conn, chan *Session) {
	sessions := make(chan *Session, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r, nil)
		if err != nil {
			return
		}
		session := NewSession(conn, source, options)
		sessions <- session
		session.Run(r.Context())
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	conn, err := Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn, sessions
}

func receive(t *testing.T, conn *Conn, v any) Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	frame, err := conn.Receive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if v != nil {
		if err := frame.Decode(v); err != nil {
			t.Fatal(err)
		}
	}
	return frame
}

func send(t *testing.T, conn *Conn, v any) {
	t.Helper()
	if err := conn.Send(context.Background(), v, nil); err != nil {
		t.Fatal(err)
	}
}

func TestSession(t *testing.T) {
	source := &testSource{reads: map[RegionPos]int{}, blocked: make(chan struct{})}
	yaw := 0.5
	conn, sessions := start(t, source, Options{Scene: Scene{Name: "测试"}, Camera: &Camera{Position: [3]float64{1, 2, 3}, Yaw: &yaw}, Workers: 1})
	send(t, conn, Hello{Type: "hello", Protocol: "r2link", Version: Version})
	var welcome Welcome
	receive(t, conn, &welcome)
	if welcome.Type != "welcome" || welcome.Scene.Name != "测试" || welcome.Camera == nil || *welcome.Camera.Yaw != 0.5 {
		t.Fatalf("welcome %+v", welcome)
	}
	session := <-sessions

	// 单线程读取：离中心近的先发；空区域尾部为空；失败的区域回复 failed。
	var want Want
	want.Type = "want"
	want.Center = [2]float64{64, 64}
	want.Regions.Add = []RegionPos{{5, 0}, {7, 7}, {1, 0}, {0, 0}}
	send(t, conn, want)
	order := []RegionPos{}
	for range 4 {
		var header struct {
			Type            string
			X, Z            int
			ClippedSections int
			Message         string
		}
		frame := receive(t, conn, &header)
		order = append(order, RegionPos{header.X, header.Z})
		switch {
		case header.Type == "failed":
			if header.X != 7 || header.Message != "读不到" {
				t.Fatalf("失败消息 %+v", header)
			}
		case header.X == 5:
			if len(frame.Tail) != 0 {
				t.Fatal("空区域应该没有尾部")
			}
		default:
			if header.ClippedSections != 2 || binary.LittleEndian.Uint32(frame.Tail) != RegionMagic || binary.LittleEndian.Uint32(frame.Tail[4:]) != 1 {
				t.Fatalf("区域 %+v 尾部 %v", header, frame.Tail[:8])
			}
			if hash := binary.LittleEndian.Uint32(frame.Tail[8+6*4:]); hash != uint32(header.X*100+header.Z+1) {
				t.Fatalf("区域 %+v 调色板 %d", header, hash)
			}
		}
	}
	if order[0] != (RegionPos{0, 0}) || order[1] != (RegionPos{1, 0}) || order[3] != (RegionPos{7, 7}) {
		t.Fatalf("发送顺序 %v", order)
	}

	// 移除正在读取的区域会取消读取，并且不发送结果。
	want.Regions.Add = []RegionPos{{9, 9}}
	send(t, conn, want)
	time.Sleep(50 * time.Millisecond)
	want.Regions.Add, want.Regions.Remove = nil, []RegionPos{{9, 9}}
	send(t, conn, want)
	select {
	case <-source.blocked:
	case <-time.After(5 * time.Second):
		t.Fatal("移除区域没有取消读取")
	}

	// 数据变化后只重发仍被需要的区域。
	source.mu.Lock()
	source.version = 1000
	source.mu.Unlock()
	session.Update(0, 0)
	session.Update(9, 9)
	var header RegionData
	frame := receive(t, conn, &header)
	if header.X != 0 || header.Z != 0 || binary.LittleEndian.Uint32(frame.Tail[8+6*4:]) != 1001 {
		t.Fatalf("更新 %+v", header)
	}

	// 对象、占用表与相机。
	want.Regions.Remove = nil
	want.BlockEntities.Add = []BlockEntityWant{{X: 0, Z: 0, Center: [3]int{3, 4, 5}, Radius: 6}}
	send(t, conn, want)
	var entities BlockEntities
	receive(t, conn, &entities)
	if entities.Type != "blockEntities" || len(entities.Entries) != 1 || entities.Entries[0].Position != [3]int{3, 6, 0} {
		t.Fatalf("方块实体 %+v", entities)
	}
	send(t, conn, Chunks{Type: "chunks"})
	var chunks Chunks
	frame = receive(t, conn, &chunks)
	if chunks.Type != "chunks" || len(frame.Tail) != 136 || int32(binary.LittleEndian.Uint32(frame.Tail)) != -1 || binary.LittleEndian.Uint32(frame.Tail[4:]) != 1 {
		t.Fatalf("占用表 %+v %v", chunks, frame.Tail[:8])
	}
	if err := session.MoveCamera(context.Background(), Camera{Position: [3]float64{7, 8, 9}}); err != nil {
		t.Fatal(err)
	}
	var move CameraMove
	receive(t, conn, &move)
	if move.Type != "camera" || move.Camera.Position != [3]float64{7, 8, 9} || move.Camera.Yaw != nil {
		t.Fatalf("相机 %+v", move)
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.reads[RegionPos{1, 0}] != 1 {
		t.Fatalf("没有变化的区域被重读 %v", source.reads)
	}
}

func TestSessionRejectsOldVersion(t *testing.T) {
	conn, _ := start(t, &testSource{reads: map[RegionPos]int{}}, Options{})
	send(t, conn, Hello{Type: "hello", Protocol: "r2link", Version: 2})
	var message Error
	receive(t, conn, &message)
	if message.Type != "error" || !strings.Contains(message.Message, "v3") {
		t.Fatalf("%+v", message)
	}
}

func TestPack(t *testing.T) {
	var blocks [4096]uint32
	for i := range blocks {
		blocks[i] = 7
	}
	if section := Pack([3]int{1, 2, 3}, &blocks); section.Bits != 0 || len(section.Words) != 0 || section.Palette[0] != 7 {
		t.Fatalf("单一方块 %+v", section)
	}
	blocks[(1<<8)|(2<<4)|3] = 9
	blocks[4095] = 11
	section := Pack([3]int{}, &blocks)
	if section.Bits != 2 || len(section.Words) != 256 || len(section.Palette) != 3 {
		t.Fatalf("位宽 %d 字数 %d", section.Bits, len(section.Words))
	}
	for i, want := range blocks {
		index := section.Words[i/16] >> (i % 16 * 2) & 3
		if section.Palette[index] != want {
			t.Fatalf("格子 %d", i)
		}
	}
}

func TestFrame(t *testing.T) {
	data, err := EncodeFrame(RegionData{Type: "region", X: -1, Z: 2}, []byte{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	frame, err := DecodeFrame(data)
	if err != nil || frame.Type != "region" || string(frame.Tail) != "\x01\x02\x03" {
		t.Fatalf("%+v %v", frame, err)
	}
	for _, bad := range [][]byte{{1}, {200, 0, 0, 0, '{'}, append([]byte{2, 0, 0, 0}, "{}"...)} {
		if _, err := DecodeFrame(bad); err == nil {
			t.Fatalf("%v 应该解码失败", bad)
		}
	}
}

// regionOnly 只实现 Source。
type regionOnly struct{}

func (regionOnly) Region(context.Context, int, int) (Region, error) { return Region{}, nil }

// 不提供对象的数据源也回复空列表，浏览器才能结束近景等待；不提供占用表时回复空表。
func TestSessionWithoutOptionalSources(t *testing.T) {
	conn, _ := start(t, regionOnly{}, Options{})
	send(t, conn, Hello{Type: "hello", Protocol: "r2link", Version: Version})
	receive(t, conn, nil)
	var want Want
	want.Type = "want"
	want.BlockEntities.Add = []BlockEntityWant{{X: 2, Z: 3, Radius: 4}}
	send(t, conn, want)
	var entities BlockEntities
	receive(t, conn, &entities)
	if entities.Type != "blockEntities" || entities.X != 2 || entities.Z != 3 || entities.Entries == nil || len(entities.Entries) != 0 {
		t.Fatalf("方块实体 %+v", entities)
	}
	send(t, conn, Chunks{Type: "chunks"})
	var chunks Chunks
	if frame := receive(t, conn, &chunks); chunks.Type != "chunks" || len(frame.Tail) != 0 {
		t.Fatalf("占用表 %+v", chunks)
	}
}
