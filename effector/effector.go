// Package effector 从方块状态产生动画实例描述，动画时钟和部件变换由浏览器负责。
package effector

import (
	"fmt"
	"neomega-blocks/ir"
	"neomega-r2/object"
)

// Builder 可从状态中提取动画参数；不接触 NBT 或存档来源。
type Builder func(position [3]int, state ir.IRBlock) (object.Descriptor, error)
type Registry map[string]Builder

// Kind 用于只需要类型和位置的效果；有状态参数的效果直接注册 Builder。
func Kind(kind string) Builder {
	return func(position [3]int, state ir.IRBlock) (object.Descriptor, error) {
		return object.Descriptor{Key: fmt.Sprintf("effect:%d/%d/%d", position[0], position[1], position[2]), Kind: kind, Position: [3]float64{float64(position[0]), float64(position[1]), float64(position[2])}}, nil
	}
}

// Build 只处理认领的方块名；返回 nil 表示保留普通静态方块外观。
func (r Registry) Build(position [3]int, state ir.IRBlock) (*object.Descriptor, error) {
	builder, ok := r[state.NameWithNameSpace()]
	if !ok {
		return nil, nil
	}
	descriptor, err := builder(position, state)
	return &descriptor, err
}
