package solidtable

import (
	"bytes"
	_ "embed"
	"sync"

	"neomega-view-utils/fixer/solidtable"
)

// 由 neomega-viewer-core 的 viewer-assets/cmd/build-tables 与几何表一起生成，
// 在 neomega-viewer-core 模块根目录运行 go generate ./viewer/resources。
//
//go:embed geometry.nvsolid
var bundled []byte

// Bundled 返回随包分发的实心表；多个调用方共享同一份只读解码结果。
var Bundled = sync.OnceValues(func() (solidtable.Table, error) {
	return solidtable.Decode(bytes.NewReader(bundled))
})
