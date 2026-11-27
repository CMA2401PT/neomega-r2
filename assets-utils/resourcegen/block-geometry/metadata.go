package blockgeometry

import (
	"neomega-blocks/ir"
	model "neomega-view-utils/r2assets/geometry/java_block_model"
)

// SkippedState 记录无法生成静态形状的 Java 状态及原因。
type SkippedState struct {
	Block  ir.IRBlock
	Reason string
}

type Renderer struct {
	Kind   model.RendererKind `json:"kind"`
	Family string             `json:"family,omitempty"`
}

// Metadata 记录建表所用的 Java 版本和静态模型的覆盖情况。
type Metadata struct {
	Version   string
	Renderers map[string]Renderer
	Skipped   []SkippedState
}
