// Package r2frontend 嵌入供 Go 宿主通过 HTTP 提供的精简前端产物。
package r2frontend

import "embed"

// Files 包含 dist/web（由 npm run build 生成，go build 之前需先构建）。
//
//go:embed dist/web
var Files embed.FS
