// 将已提取的客户端资源按所选主题写出，同一次构建共享图集与方块几何。
package main

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"

	"neomega-blocks/blockconv"
	model "neomega-view-utils/r2assets/geometry/java_block_model"
	blockgeometry "neomega-view-utils/r2assets/resourcegen/block-geometry"
	browsermaterials "neomega-view-utils/r2assets/resourcegen/browser-materials"
	cubematerials "neomega-view-utils/r2assets/resourcegen/cube-materials"
	itemmodels "neomega-view-utils/r2assets/resourcegen/item-models"
	solidfaces "neomega-view-utils/r2assets/resourcegen/solid-faces"
	topcolors "neomega-view-utils/r2assets/resourcegen/top-colors"
)

func write(path string, encode func(io.Writer) error) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	return errors.Join(encode(f), f.Close())
}

func compile(version, root string, topics []string) error {
	assets := filepath.Join(root, "java-assets")
	bundle, err := model.Load(assets)
	if err != nil {
		return err
	}
	if bundle.Info.Version != version {
		return fmt.Errorf("客户端版本 %s 与所选版本 %s 不符", bundle.Info.Version, version)
	}
	if slices.Contains(topics, "item-models") {
		items, err := itemmodels.Generate(assets, bundle)
		if err != nil {
			return err
		}
		err = write(filepath.Join(root, "item-models", "static-item-models.json.gz"), func(w io.Writer) error {
			zip := gzip.NewWriter(w)
			return errors.Join(json.NewEncoder(zip).Encode(items), zip.Close())
		})
		if err != nil {
			return err
		}
	}
	if !slices.Contains(topics, "block-geometry") {
		return nil
	}
	native, err := os.ReadFile(filepath.Join(root, "java-blocks", "java_states.list"))
	if err != nil {
		return err
	}
	history, err := os.ReadFile(filepath.Join(root, "java-blocks", "java_compatibility.list"))
	if err != nil {
		return err
	}
	states := blockconv.NewWaterloggedStates(native, history)
	blocks, err := blockgeometry.Generate(states, bundle, nil)
	if err != nil {
		return err
	}
	if err := write(filepath.Join(root, "block-geometry", "block-geometry.nvtables"), blocks.Encode); err != nil {
		return err
	}
	if err := write(filepath.Join(root, "block-geometry", "static-block-renderers.json"), func(w io.Writer) error { return json.NewEncoder(w).Encode(blocks.Metadata) }); err != nil {
		return err
	}
	if slices.Contains(topics, "solid-faces") {
		solid := solidfaces.Generate(blocks.Tables)
		if err := write(filepath.Join(root, "solid-faces", "solid-faces.nvsolid"), solid.Encode); err != nil {
			return err
		}
	}
	if !slices.Contains(topics, "top-colors") {
		return nil
	}
	colors := topcolors.Generate(blocks.Tables, bundle.AtlasImage)
	if err := write(filepath.Join(root, "top-colors", "top-colors.nvcolor"), colors.Encode); err != nil {
		return err
	}
	if !slices.Contains(topics, "cube-materials") {
		return nil
	}
	cubes, err := cubematerials.Generate(states.NativeStates(), blocks.Tables, bundle.AtlasImage, colors)
	if err != nil {
		return err
	}
	if err := write(filepath.Join(root, "cube-materials", "cube-materials.bin"), func(w io.Writer) error { return cubematerials.Encode(w, cubes) }); err != nil {
		return err
	}
	if slices.Contains(topics, "browser-materials") {
		return browsermaterials.WriteRecipe(states, blocks.Tables, cubes, filepath.Join(root, "recipe"))
	}
	return nil
}

func main() {
	version := flag.String("java", "", "Java 客户端版本")
	root := flag.String("work", "", "生成器工作目录")
	flag.Parse()
	if err := compile(*version, *root, flag.Args()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
