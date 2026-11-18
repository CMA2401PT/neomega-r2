// Package blockactor 把需要 NBT 的近景方块交给专门处理器，输出通用的射线对象描述。
package blockactor

import (
	"neomega-blocks/ir"
	nbt "neomega-nbt/presets/v1"
	"neomega-r2link/object"
)

type Input struct {
	Position [3]int
	State    ir.IRBlock
	NBT      nbt.Compound
}

// Handler 解释某类方块的状态与 NBT；外观通过 Descriptor.Kind 对应浏览器中的对象工厂。
type Handler interface {
	BlockNames() []string
	Build(input Input) ([]object.Descriptor, error)
}

type Registry map[string]Handler

// Register 将处理器声明的方块名加入路由，应用决定启用哪些实现。
func (r Registry) Register(handler Handler) {
	for _, name := range handler.BlockNames() {
		r[name] = handler
	}
}

// Build 只对已经认领的方块生成外观，未认领的方块保留静态模型。
func (r Registry) Build(input Input) ([]object.Descriptor, error) {
	handler, ok := r[input.State.NameWithNameSpace()]
	if !ok {
		return nil, nil
	}
	return handler.Build(input)
}
