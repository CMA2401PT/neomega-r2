package geometry

// BlockID 是输入资源的方块状态编号。
type BlockID interface{ ~uint32 | ~uint64 }

type ModelID uint32

type Tables[B BlockID] struct {
	// 表和查询返回的切片共享且只读，供多个渲染入口复用。
	Index  map[B][]ModelID
	Shapes []Shape
	// 仅流体几何有此映射，上方同组几何出现时改用满高度几何。
	FullHeight map[ModelID]ModelID
}
