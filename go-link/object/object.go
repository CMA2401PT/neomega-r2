// Package object 定义特殊对象的传输描述，不决定存档读取、调度或绘制实现。
package object

import "encoding/json"

// Descriptor 用稳定位置和类型标识实例；Data 由同类型的浏览器工厂解释。
// Replace 为 true 时，实例准备完成后替换所在格的静态本体，卸载时恢复本体。
type Descriptor struct {
	Key      string          `json:"key"`
	Kind     string          `json:"kind"`
	Position [3]float64      `json:"position"`
	Data     json.RawMessage `json:"data,omitempty"`
	Replace  bool            `json:"replace,omitempty"`
}
