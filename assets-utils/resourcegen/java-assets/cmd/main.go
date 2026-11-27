// SPDX-License-Identifier: MIT
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"neomega-view-utils/r2assets/resourcegen/java-assets/atlas"
	"neomega-view-utils/r2assets/resourcegen/java-assets/extract"
	"neomega-view-utils/r2assets/resourcegen/java-assets/models"
	"neomega-view-utils/r2assets/resourcegen/java-assets/patch"
	"neomega-view-utils/r2assets/resourcegen/java-assets/special"
	"neomega-view-utils/r2assets/resourcegen/java-assets/utils/fetch"
	"neomega-view-utils/r2assets/resourcegen/java-assets/utils/inventory"
)

type paths []string

func (value *paths) String() string        { return fmt.Sprint([]string(*value)) }
func (value *paths) Set(path string) error { *value = append(*value, path); return nil }

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: neomega-assets <fetch|extract|patch|models|special|atlas|audit|build> -help")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	var overlays paths
	switch args[0] {
	case "fetch":
		version := flags.String("version", "", "Mojang release ID, or latest for the latest stable release")
		cache := flags.String("cache", ".cache", "download directory")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		result, err := fetch.Run(ctx, fetch.Options{Version: *version, CacheDir: *cache})
		if err != nil {
			return err
		}
		fmt.Printf("Minecraft %s: %s\n", result.Version.ID, result.JarPath)
		return nil
	case "extract":
		jar := flags.String("jar", "", "local client JAR")
		output := flags.String("out", "build/java-assets/works/extracted", "extracted assets and snapshot.json")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *jar == "" {
			return fmt.Errorf("extract requires -jar")
		}
		snapshot, err := extract.Run(ctx, extract.Options{JarPath: *jar, OutputDir: *output})
		if err != nil {
			return err
		}
		fmt.Printf("提取：%s, %d blockstates, %d models, %d PNGs -> %s\n", snapshot.Version, len(snapshot.BlockStates), len(snapshot.Models), len(snapshot.Textures), *output)
		return nil
	case "patch":
		input := flags.String("in", "build/java-assets/works/extracted", "extracted snapshot directory")
		output := flags.String("out", "build/java-assets/works/patched", "patched snapshot directory")
		flags.Var(&overlays, "overlay", "resource pack directory; may be repeated, last wins")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		snapshot, err := patch.Run(ctx, patch.Options{InputDir: *input, OutputDir: *output, ResourcePacks: overlays})
		if err != nil {
			return err
		}
		fmt.Printf("应用覆盖：%d blockstates, %d models -> %s\n", len(snapshot.BlockStates), len(snapshot.Models), *output)
		return nil
	case "models":
		input := flags.String("in", "build/java-assets/works/patched", "patched snapshot directory")
		output := flags.String("out", "build/java-assets/works/models", "model table and report directory")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		report, err := models.Run(models.Options{InputDir: *input, OutputDir: *output})
		if err != nil {
			return err
		}
		fmt.Printf("解析模型：%d blockstates, %d models, %d referenced textures, %d geometryless blockstates -> %s\n", report.BlockStateCount, report.ModelCount, len(report.RequiredTextures), len(report.GeometrylessBlockStates), *output)
		return nil
	case "special":
		templateDir := flags.String("templates", "resourcegen/java-assets/special/templates", "特殊方块静态模型的模板目录")
		input := flags.String("in", "build/java-assets/works/patched", "patched snapshot directory")
		modelDir := flags.String("models", "build/java-assets/works/models", "model table/report directory")
		output := flags.String("out", "build/java-assets/works/renderers", "completed models and renderer plans")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		report, err := special.Run(ctx, special.Options{Templates: os.DirFS(*templateDir), InputDir: *input, ModelDir: *modelDir, OutputDir: *output})
		if err != nil {
			return err
		}
		fmt.Printf("处理特殊方块：renderer counts %v -> %s\n", report.Counts, *output)
		return nil
	case "atlas":
		input := flags.String("in", "build/java-assets/works/renderers", "补全特殊方块后的快照目录")
		modelDir := flags.String("models", "build/java-assets/works/renderers", "model table/report directory")
		output := flags.String("out", "build/java-assets/final", "final output directory")
		tile := flags.Int("tile-size", 16, "block texture tile size, power of two")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		atlas, err := atlas.Run(ctx, atlas.Options{InputDir: *input, ModelDir: *modelDir, OutputDir: *output, TileSize: *tile})
		if err != nil {
			return err
		}
		fmt.Printf("生成图集：%d textures, %dx%d atlas -> %s\n", len(atlas.Textures), atlas.Width, atlas.Height, *output)
		return nil
	case "audit":
		baseline := flags.String("baseline", "", "baseline mc-assets directory with tables")
		current := flags.String("current", "build/java-assets/final", "current final output")
		snapshot := flags.String("snapshot", "build/java-assets/works/extracted", "original JAR snapshot")
		raw := flags.String("raw-models", "build/java-assets/works/models", "models before special previews")
		completed := flags.String("completed", "build/java-assets/works/renderers", "completed models/index")
		output := flags.String("out", "build/java-assets/audits/atlas-inventory.json", "inventory report path")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *baseline == "" {
			return fmt.Errorf("audit requires -baseline")
		}
		report, err := inventory.Run(inventory.Options{BaselineDir: *baseline, CurrentDir: *current, SnapshotDir: *snapshot, RawModelDir: *raw, CompletedDir: *completed, OutputPath: *output})
		if err != nil {
			return err
		}
		fmt.Printf("audit: %d -> %d textures, %d missing JAR block textures, %d missing references, geometry regressions %d -> %d\n", report.BaselineTextures, report.CurrentTextures, len(report.MissingCurrentBlockPNGs), len(report.MissingRequiredTextures), len(report.BeforeMissingGeometry), len(report.AfterMissingGeometry))
		return nil
	case "build":
		templateDir := flags.String("templates", "resourcegen/java-assets/special/templates", "特殊方块静态模型的模板目录")
		jar := flags.String("jar", "", "local JAR; when omitted fetch -version")
		version := flags.String("version", "", "release ID when downloading")
		cache := flags.String("cache", ".cache", "download directory")
		work := flags.String("work", "build/java-assets/works", "intermediate directories")
		output := flags.String("out", "build/java-assets/final", "final output directory")
		flags.Var(&overlays, "overlay", "resource pack directory; may be repeated, last wins")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		jarPath := *jar
		if jarPath == "" {
			result, err := fetch.Run(ctx, fetch.Options{Version: *version, CacheDir: *cache})
			if err != nil {
				return err
			}
			jarPath = result.JarPath
			fmt.Printf("fetch: Minecraft %s -> %s\n", result.Version.ID, jarPath)
		}
		extracted := filepath.Join(*work, "extracted")
		patched := filepath.Join(*work, "patched")
		modelDir := filepath.Join(*work, "models")
		snapshot, err := extract.Run(ctx, extract.Options{JarPath: jarPath, OutputDir: extracted})
		if err != nil {
			return err
		}
		fmt.Printf("提取：extracted Minecraft %s\n", snapshot.Version)
		if _, err := patch.Run(ctx, patch.Options{InputDir: extracted, OutputDir: patched, ResourcePacks: overlays}); err != nil {
			return err
		}
		fmt.Println("应用覆盖：patched assets")
		report, err := models.Run(models.Options{InputDir: patched, OutputDir: modelDir})
		if err != nil {
			return err
		}
		fmt.Printf("解析模型：%d models, %d geometryless blockstates\n", report.ModelCount, len(report.GeometrylessBlockStates))
		completed := filepath.Join(*work, "renderers")
		rendering, err := special.Run(ctx, special.Options{Templates: os.DirFS(*templateDir), InputDir: patched, ModelDir: modelDir, OutputDir: completed})
		if err != nil {
			return err
		}
		fmt.Printf("处理特殊方块：renderer counts %v\n", rendering.Counts)
		atlas, err := atlas.Run(ctx, atlas.Options{InputDir: completed, ModelDir: completed, OutputDir: *output, TileSize: 16})
		if err != nil {
			return err
		}
		fmt.Printf("生成图集：%d textures, %dx%d -> %s\n", len(atlas.Textures), atlas.Width, atlas.Height, *output)
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
