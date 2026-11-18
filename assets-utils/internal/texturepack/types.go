package texturepack

// Part 保留配方中的名字和采样方向，覆盖层换图时才能连同染色一起重建。
type Part struct {
	Texture string     `json:"texture"`
	UV      [6]float64 `json:"uv"`
	Tint    [3]float32 `json:"tint"`
	Cutout  bool       `json:"cutout,omitempty"`
}

// Manifest 保留原版回退区域、立方体合成配方和四边形记录对应的贴图名字。
type Manifest struct {
	Textures map[string][4]float32 `json:"textures"`
	Layers   [][]Part              `json:"layers"`
	Quads    []string              `json:"quads"`
}

// Info 让上传方为三通道分配相同布局，层边长决定 mip 数。
type Info struct {
	Side        int `json:"side"`
	Levels      int `json:"levels"`
	Layers      int `json:"layers"`
	AtlasWidth  int `json:"atlasWidth"`
	AtlasHeight int `json:"atlasHeight"`
}

// Set 一起交付合成图片与派生模型表，避免切换时混用两套透明度。
type Set struct {
	Info  Info              `json:"info"`
	Files map[string][]byte `json:"-"`
}
