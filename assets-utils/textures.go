package r2assets

import (
	"archive/zip"
	"io/fs"
	"neomega-view-utils/r2assets/internal/texturepack"
	"os"
)

// TextureSet 将贴图和派生表作为一个整体交给宿主。
type TextureSet = texturepack.Set

// BuildTextures 按目录或 zip 合成 GPU 图片和匹配的模型表，空路径使用原版。
// maxSize 使用 16、32、64、128、256 或 512；零值采用 128。
func BuildTextures(path string, maxSize int) (*TextureSet, error) {
	if maxSize == 0 {
		maxSize = 128
	}
	source, err := fs.Sub(Files, "assets")
	if err != nil {
		return nil, err
	}
	var pack fs.FS
	if path != "" {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.IsDir() {
			pack = os.DirFS(path)
		} else {
			archive, err := zip.OpenReader(path)
			if err != nil {
				return nil, err
			}
			defer archive.Close()
			pack = archive
		}
	}
	return texturepack.Build(source, pack, maxSize)
}
