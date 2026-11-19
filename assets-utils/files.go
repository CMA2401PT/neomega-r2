package r2assets

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/binary"
	"io"
	"io/fs"
	"strings"
)

//go:embed assets.zip
var packedAssets string

// Files 按 assets/ 下的原文件名读取默认资源。只有被读取的文件才会展开。
var Files = openAssets()

type assetFiles struct {
	archive *zip.Reader
}

func openAssets() assetFiles {
	r, err := zip.NewReader(strings.NewReader(packedAssets), int64(len(packedAssets)))
	if err != nil {
		panic(err)
	}
	return assetFiles{archive: r}
}

func (a assetFiles) ReadFile(name string) ([]byte, error)       { return fs.ReadFile(a.archive, name) }
func (a assetFiles) ReadDir(name string) ([]fs.DirEntry, error) { return fs.ReadDir(a.archive, name) }

// Open 提供可定位的普通文件，HTTP 按范围读取和检测文件类型时需要移动读指针。
func (a assetFiles) Open(name string) (fs.File, error) {
	f, err := a.archive.Open(name)
	if err != nil {
		return nil, err
	}
	if _, dir := f.(fs.ReadDirFile); dir {
		return f, nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	data, err := fs.ReadFile(a.archive, name)
	if err != nil {
		return nil, err
	}
	return &assetFile{bytes.NewReader(data), info}, nil
}

type assetFile struct {
	*bytes.Reader
	info fs.FileInfo
}

func (f *assetFile) Close() error               { return nil }
func (f *assetFile) Stat() (fs.FileInfo, error) { return f.info, nil }

// OpenGzip 为 HTTP 返回可直接发送的 gzip 表示和字节数。ZIP 和 gzip 共用 DEFLATE 数据；
// 补上固定头、原文件的校验和与长度即可，传输时无需解压和重压。
func (a assetFiles) OpenGzip(name string) (io.Reader, int64, error) {
	for _, entry := range a.archive.File {
		if entry.Name != name {
			continue
		}
		raw, err := entry.OpenRaw()
		if err != nil {
			return nil, 0, err
		}
		header := []byte{0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255}
		var trailer [8]byte
		binary.LittleEndian.PutUint32(trailer[:4], entry.CRC32)
		binary.LittleEndian.PutUint32(trailer[4:], uint32(entry.UncompressedSize64))
		return io.MultiReader(bytes.NewReader(header), raw, bytes.NewReader(trailer[:])), int64(entry.CompressedSize64) + 18, nil
	}
	return nil, 0, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}
