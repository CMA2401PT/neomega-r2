// Package r2 嵌入渲染核心的构建产物与验证页，供 Go 宿主通过 HTTP 提供。
// 资源包由 neomega-view-utils/r2assets 提供，不在本模块内。
package r2

import "embed"

// Files 包含 dist（npm run build 生成，go build 之前需要先构建一次）与 demo。
//
//go:embed dist demo/*
var Files embed.FS
