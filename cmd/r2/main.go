// r2 提供独立的模型表和格子数据，HTTP 请求不进入旧 viewer 的网格处理管线。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	r2 "neomega-r2"
	"neomega-view-utils/r2assets"
	"net/http"
	"os"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:2413", "研究页面监听地址")
	webPath := flag.String("web", "", "开发时直接读取验证页目录")
	corePath := flag.String("core", "", "开发时直接读取渲染核心的构建目录（dist）")

	flag.Parse()
	catalog, err := r2assets.OpenCatalog()
	if err != nil {
		panic(err)
	}
	table, err := r2assets.OpenStates()
	if err != nil {
		panic(err)
	}
	models := r2.StateModels(table)
	scenes := map[string]*r2.Scene{}
	data := map[string][]byte{}
	for _, name := range []string{"special", "showcase", "fences", "cutouts", "cubes", "glass8", "glass16", "spill"} {
		scene, err := r2.BuildScene(catalog, models, name)
		if err != nil {
			panic(err)
		}
		scenes[name] = scene
		data[name] = scene.Grid.Bytes()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/scene", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		scene, ok := scenes[name]
		if !ok {
			http.Error(w, "未知场景", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(scene)
	})
	mux.HandleFunc("GET /api/cells", func(w http.ResponseWriter, r *http.Request) {
		value, ok := data[r.URL.Query().Get("name")]
		if !ok {
			http.Error(w, "未知场景", 404)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(value)
	})
	mux.HandleFunc("GET /api/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(catalog.Statistics)
	})
	assets, err := fs.Sub(r2assets.Files, "assets")
	if err != nil {
		panic(err)
	}
	web, err := fs.Sub(r2.Files, "demo")
	if err != nil {
		panic(err)
	}
	core, err := fs.Sub(r2.Files, "dist")
	if err != nil {
		panic(err)
	}
	mux.Handle("/assets/", http.StripPrefix("/assets/", http.FileServerFS(assets)))
	if *webPath != "" {
		web = os.DirFS(*webPath)
	}
	if *corePath != "" {
		core = os.DirFS(*corePath)
	}
	mux.Handle("/r2/", http.StripPrefix("/r2/", http.FileServerFS(core)))
	files := http.FileServerFS(web)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		files.ServeHTTP(w, r)
	})
	fmt.Println("R2 格子内模型射线研究：http://" + *listen)
	if err := http.ListenAndServe(*listen, mux); err != nil {
		panic(err)
	}
}
