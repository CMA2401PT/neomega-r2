package r2link

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
)

// Source 提供区域方块。Region 可能被并发调用；ctx 在区域不再需要或连接结束时取消。
type Source interface {
	Region(ctx context.Context, x, z int) (R2Region, error)
}

// BlockEntitySource 是可选接口：提供区域内、以区块坐标 center 为圆心 radius 区块以内的方块实体。
// 竖直方向通常只取 center 上下 min(radius+1, 12) 个 section。不实现时，会话对每个请求回复空列表。
type BlockEntitySource interface {
	BlockEntities(ctx context.Context, x, z int, center [3]int, radius int) ([]BlockEntity, error)
}

// EntitySource 按同一近景范围提供普通实体的 Java SNBT。会话只负责传输。
type EntitySource interface {
	Entities(ctx context.Context, x, z int, center [3]int, radius int) ([]string, error)
}

// ChunkSource 是可选接口：列出存在的区块，地图据此显示世界分布。
type ChunkSource interface {
	Chunks(ctx context.Context) (ChunkIndex, error)
}

// Options 是 welcome 的内容与读取并发数。
type Options struct {
	Scene  Scene
	Camera *Camera
	// Workers 是同时读取的区域数，默认 4；方块实体一次读一个区域。
	Workers int
}

// Session 服务一条浏览器连接：记录浏览器需要的区域和方块实体，离远景中心近的先读，
// 不再需要的读取立即取消。数据变化时调用 Update 或 Refresh，仍被需要的部分会重新发送。
type Session struct {
	conn    *Conn
	source  Source
	options Options

	mu            sync.Mutex
	wake          *sync.Cond
	closed        bool
	center        [2]float64
	regions       map[RegionPos]bool
	pending       map[RegionPos]bool
	active        map[RegionPos]*job
	entityWants   map[RegionPos]BlockEntityWant
	entityPending map[RegionPos]bool
	entityOn      *entityJob
}

type job struct{ cancel context.CancelFunc }

type entityJob struct {
	key    RegionPos
	cancel context.CancelFunc
}

// NewSession 准备服务 conn；Run 开始握手和收发。
func NewSession(conn *Conn, source Source, options Options) *Session {
	if options.Workers <= 0 {
		options.Workers = 4
	}
	s := &Session{
		conn: conn, source: source, options: options,
		regions: map[RegionPos]bool{}, pending: map[RegionPos]bool{}, active: map[RegionPos]*job{},
		entityWants: map[RegionPos]BlockEntityWant{}, entityPending: map[RegionPos]bool{},
	}
	s.wake = sync.NewCond(&s.mu)
	return s
}

// Serve 是 NewSession(conn, source, options).Run(ctx)。
func Serve(ctx context.Context, conn *Conn, source Source, options Options) error {
	return NewSession(conn, source, options).Run(ctx)
}

// Run 完成握手后处理浏览器消息，直到连接关闭或 ctx 结束；返回前关闭连接并等待读取结束。
func (s *Session) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { s.conn.CloseNow() })
	defer stop()
	defer s.conn.CloseNow()
	frame, err := s.conn.Receive(ctx)
	if err != nil {
		return err
	}
	var hello Hello
	if err := frame.Decode(&hello); err != nil || frame.Type != "hello" || hello.Protocol != "r2link" || hello.Version != Version {
		message := fmt.Sprintf("需要 R2Link v%d 的 hello", Version)
		s.conn.Send(ctx, Error{Type: "error", Message: message}, nil)
		s.conn.Close(message)
		return errors.New(message)
	}
	welcome := Welcome{Type: "welcome", Protocol: "r2link", Version: Version, Scene: s.options.Scene, Camera: s.options.Camera}
	if err := s.conn.Send(ctx, welcome, nil); err != nil {
		return err
	}
	var workers sync.WaitGroup
	for range s.options.Workers {
		workers.Go(func() { s.regionWorker(ctx) })
	}
	entities, ok := s.source.(BlockEntitySource)
	if !ok {
		entities = noBlockEntities{}
	}
	workers.Go(func() { s.entityWorker(ctx, entities) })
	defer func() {
		s.mu.Lock()
		s.closed = true
		for _, job := range s.active {
			job.cancel()
		}
		if s.entityOn != nil {
			s.entityOn.cancel()
		}
		s.wake.Broadcast()
		s.mu.Unlock()
		// 关闭连接让阻塞在写入上的协程返回。
		s.conn.CloseNow()
		workers.Wait()
	}()
	for {
		frame, err := s.conn.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		switch frame.Type {
		case "want":
			var want Want
			if err := frame.Decode(&want); err != nil {
				return err
			}
			s.apply(want)
		case "chunks":
			go s.sendChunks(ctx)
		}
	}
}

// apply 更新需要的集合：移除的取消在途读取，新增的排队；近景订阅圆心变化时重读。
func (s *Session) apply(want Want) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.center = want.Center
	for _, key := range want.Regions.Remove {
		delete(s.regions, key)
		delete(s.pending, key)
		if job := s.active[key]; job != nil {
			job.cancel()
			delete(s.active, key)
		}
	}
	for _, key := range want.Regions.Add {
		s.regions[key] = true
		s.pending[key] = true
	}
	for _, key := range want.BlockEntities.Remove {
		delete(s.entityWants, key)
		delete(s.entityPending, key)
		if s.entityOn != nil && s.entityOn.key == key {
			s.entityOn.cancel()
			s.entityOn = nil
		}
	}
	for _, value := range want.BlockEntities.Add {
		key := RegionPos{value.X, value.Z}
		s.entityWants[key] = value
		s.entityPending[key] = true
		if s.entityOn != nil && s.entityOn.key == key {
			s.entityOn.cancel()
			s.entityOn = nil
		}
	}
	s.wake.Broadcast()
}

// Update 表示区域 (x, z) 的方块变了；浏览器仍需要它时重新读取并发送。
func (s *Session) Update(x, z int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := RegionPos{x, z}
	if s.regions[key] {
		s.pending[key] = true
		s.wake.Broadcast()
	}
}

// UpdateBlockEntities 重新发送该区域的近景快照，适用于方块实体和普通实体的变动。
func (s *Session) UpdateBlockEntities(x, z int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := RegionPos{x, z}
	if _, ok := s.entityWants[key]; ok {
		s.entityPending[key] = true
		if s.entityOn != nil && s.entityOn.key == key {
			s.entityOn.cancel()
			s.entityOn = nil
		}
		s.wake.Broadcast()
	}
}

// Refresh 重新发送所有仍被需要的区域与方块实体，用于整个世界换了内容。
func (s *Session) Refresh() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key := range s.regions {
		s.pending[key] = true
	}
	for key := range s.entityWants {
		s.entityPending[key] = true
	}
	if s.entityOn != nil {
		s.entityOn.cancel()
		s.entityOn = nil
	}
	s.wake.Broadcast()
}

// MoveCamera 让浏览器把相机移到指定位置。
func (s *Session) MoveCamera(ctx context.Context, camera Camera) error {
	return s.conn.Send(ctx, CameraMove{Type: "camera", Camera: camera}, nil)
}

// SetScene 更新浏览器显示的世界描述。
func (s *Session) SetScene(ctx context.Context, scene Scene) error {
	return s.conn.Send(ctx, SceneChange{Type: "scene", Scene: scene}, nil)
}

// distance 是区域中心到远景中心的平方距离。
func (s *Session) distance(key RegionPos) float64 {
	dx := float64(key.X)*128 + 64 - s.center[0]
	dz := float64(key.Z)*128 + 64 - s.center[1]
	return dx*dx + dz*dz
}

// nextRegion 取离中心最近、且没有在读的区域；同一区域的两次读取不会重叠，后发的内容总是更新。
func (s *Session) nextRegion() (RegionPos, bool) {
	best, found, distance := RegionPos{}, false, math.Inf(1)
	for key := range s.pending {
		if s.active[key] != nil {
			continue
		}
		if d := s.distance(key); d < distance {
			best, found, distance = key, true, d
		}
	}
	return best, found
}

func (s *Session) regionWorker(ctx context.Context) {
	for {
		s.mu.Lock()
		key, ok := s.nextRegion()
		for !s.closed && !ok {
			s.wake.Wait()
			key, ok = s.nextRegion()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		delete(s.pending, key)
		jobCtx, cancel := context.WithCancel(ctx)
		current := &job{cancel: cancel}
		s.active[key] = current
		s.mu.Unlock()

		region, err := s.source.Region(jobCtx, key.X, key.Z)

		s.mu.Lock()
		valid := s.active[key] == current && jobCtx.Err() == nil
		if s.active[key] == current {
			delete(s.active, key)
		}
		s.wake.Broadcast()
		s.mu.Unlock()
		cancel()
		if !valid {
			continue
		}
		if err != nil {
			err = s.conn.Send(ctx, Failed{Type: "failed", X: key.X, Z: key.Z, Message: err.Error()}, nil)
		} else {
			var tail []byte
			if len(region.Sections) > 0 {
				tail = EncodeRegion(region.Sections)
			}
			err = s.conn.Send(ctx, RegionData{Type: "region", X: key.X, Z: key.Z, ClippedSections: region.Clipped}, tail)
		}
		if err != nil {
			s.conn.CloseNow()
			return
		}
	}
}

func (s *Session) nextBlockEntities() (BlockEntityWant, bool) {
	best, found, distance := BlockEntityWant{}, false, math.Inf(1)
	for key := range s.entityPending {
		if d := s.distance(key); d < distance {
			best, found, distance = s.entityWants[key], true, d
		}
	}
	return best, found
}

// noBlockEntities 让不提供方块实体的数据源也回复 blockEntities，浏览器据此结束近景等待。
type noBlockEntities struct{}

func (noBlockEntities) BlockEntities(context.Context, int, int, [3]int, int) ([]BlockEntity, error) {
	return nil, nil
}

func (s *Session) entityWorker(ctx context.Context, source BlockEntitySource) {
	for {
		s.mu.Lock()
		want, ok := s.nextBlockEntities()
		for !s.closed && !ok {
			s.wake.Wait()
			want, ok = s.nextBlockEntities()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		key := RegionPos{want.X, want.Z}
		delete(s.entityPending, key)
		jobCtx, cancel := context.WithCancel(ctx)
		current := &entityJob{key: key, cancel: cancel}
		s.entityOn = current
		s.mu.Unlock()

		entries, err := source.BlockEntities(jobCtx, want.X, want.Z, want.Center, want.Radius)
		var entities []string
		if provider, ok := s.source.(EntitySource); ok && err == nil {
			entities, err = provider.Entities(jobCtx, want.X, want.Z, want.Center, want.Radius)
		}

		s.mu.Lock()
		valid := s.entityOn == current && jobCtx.Err() == nil
		if s.entityOn == current {
			s.entityOn = nil
		}
		s.mu.Unlock()
		cancel()
		if !valid {
			continue
		}
		if entries == nil {
			entries = []BlockEntity{}
		}
		if err != nil {
			err = s.conn.Send(ctx, Failed{Type: "failed", X: key.X, Z: key.Z, Message: err.Error()}, nil)
		} else {
			err = s.conn.Send(ctx, BlockEntities{Type: "blockEntities", X: key.X, Z: key.Z, Center: want.Center, Radius: want.Radius, Entries: entries, Entities: entities}, nil)
		}
		if err != nil {
			s.conn.CloseNow()
			return
		}
	}
}

// sendChunks 回复占用表；数据源不提供时回复空表。
func (s *Session) sendChunks(ctx context.Context) {
	var tail []byte
	reply := Chunks{Type: "chunks"}
	if source, ok := s.source.(ChunkSource); ok {
		index, err := source.Chunks(ctx)
		if err != nil {
			reply.Message = err.Error()
		} else {
			tail = index.Encode()
		}
	}
	if ctx.Err() == nil {
		s.conn.Send(ctx, reply, tail)
	}
}
