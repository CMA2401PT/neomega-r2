package itemmodels

import (
	"errors"
	"fmt"
	"path/filepath"

	"neomega-view-utils/r2assets/geometry"
	model "neomega-view-utils/r2assets/geometry/java_block_model"
	"neomega-view-utils/r2assets/item_render"
	"neomega-view-utils/r2assets/resourcegen/java-assets/asset"
	"neomega-view-utils/r2assets/resourcegen/java-assets/utils/jsonfile"
)

// Generate 用物品定义和公共图集生成静态展示模型。
func Generate(assetsDir string, bundle *model.Bundle) (*item_render.Catalog, error) {
	// 物品和框体都使用当前 Bundle 的图集；不依赖运行时源码目录。
	definitions, err := jsonfile.Read[asset.ItemModels](filepath.Join(assetsDir, "items.json"))
	if err != nil {
		return nil, err
	}
	resolver := model.NewResolver(bundle.Models)
	catalog := &item_render.Catalog{Items: map[string]geometry.Mesh{}, Models: map[string]geometry.Mesh{}, Unsupported: definitions.Unsupported}
	for id, target := range definitions.Models {
		resolved, err := resolver.Resolve(target)
		if err != nil {
			return nil, err
		}
		mesh, err := bake(resolved, bundle.Atlas, bundle.AtlasImage, definitions.Tints[id]...)
		if errors.Is(err, errUnsupportedModel) {
			catalog.Unsupported[id] = err.Error()
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("item %s: %w", id, err)
		}
		catalog.Items[id] = mesh
	}
	for _, id := range []model.ResourceID{"minecraft:block/item_frame", "minecraft:block/glow_item_frame"} {
		resolved, err := resolver.Resolve(id)
		if err != nil {
			return nil, err
		}
		mesh, err := bake(resolved, bundle.Atlas, bundle.AtlasImage)
		if err != nil {
			return nil, err
		}
		catalog.Models[string(id)] = mesh
	}
	return catalog, nil
}
