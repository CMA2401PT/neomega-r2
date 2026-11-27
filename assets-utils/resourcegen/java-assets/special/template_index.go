// SPDX-License-Identifier: MIT
// 社区模板来自采用 MIT 许可的 mc-assets。命令提供索引和模型，原作者署名保存在 JSON 中。
package special

import (
	"encoding/json"
	"io/fs"

	jmodel "neomega-view-utils/r2assets/geometry/java_block_model"
	"neomega-view-utils/r2assets/resourcegen/java-assets/asset"
)

type templateIndex struct {
	files      fs.FS
	Repository string                       `json:"repository"`
	Revision   string                       `json:"revision"`
	States     map[jmodel.ResourceID]string `json:"states"`
	Models     map[jmodel.ResourceID]string `json:"models"`
	Textures   map[jmodel.ResourceID]string `json:"textures"`
	Origins    map[string]string            `json:"origins"`
	Credits    []string                     `json:"credits"`
}

// loadTemplateIndex 从调用方选择的模板目录读取资源名和署名。
func loadTemplateIndex(files fs.FS) (templateIndex, error) {
	index := templateIndex{files: files}
	data, err := fs.ReadFile(files, "index.json")
	if err != nil {
		return index, err
	}
	err = json.Unmarshal(data, &index)
	return index, err
}

// Read 按索引记录的路径，从调用方传入的文件系统读取模板。
func (index templateIndex) Read(path string) ([]byte, error) {
	return fs.ReadFile(index.files, path)
}

// StateOrigin 查询方块状态模板在上游仓库中的路径。
func (index templateIndex) StateOrigin(id jmodel.ResourceID) string {
	return index.origin(index.States[id])
}

// ModelOrigin 返回模型的上游路径。
func (index templateIndex) ModelOrigin(path string) string {
	return index.origin(path)
}

// TextureOrigin 返回纹理的上游路径。
func (index templateIndex) TextureOrigin(path string) string {
	return index.origin(path)
}

// Source 记录模板所用的来源版本与声明。
func (index templateIndex) Source() asset.Source {
	return asset.Source{
		Kind:     "community-static-previews",
		Location: index.Repository + "/tree/" + index.Revision + "/custom",
		License:  "MIT; original model credits retained; Minecraft-derived material retains original rights",
	}
}

func (index templateIndex) origin(path string) string {
	return index.Repository + "@" + index.Revision + "/" + index.Origins[path]
}
