package main

import (
	"archive/zip"
	"os"
	"path/filepath"
)

// packAssets 按文件名顺序写入分发归档，使相同输入生成相同的 ZIP。
func packAssets(directory string) error {
	// 先完整写好再替换，以便生成中断时仍能使用已有资源。
	out, err := os.CreateTemp(".", "assets-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	w := zip.NewWriter(out)
	files, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, f := range files {
		name := "assets/" + f.Name()
		data, err := os.ReadFile(filepath.Join(directory, f.Name()))
		if err != nil {
			return err
		}
		entry, err := w.Create(name)
		if err != nil {
			return err
		}
		if _, err := entry.Write(data); err != nil {
			return err
		}
	}
	if err := w.Close(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(out.Name(), "assets.zip")
}
