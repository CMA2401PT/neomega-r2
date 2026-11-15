// Package material 描述源资源中的贴图采样属性。
package material

type Mode string

const (
	Opaque Mode = "opaque"
	Cutout Mode = "cutout"
	Blend  Mode = "blend"
)

type Surface struct {
	Texture string `json:"texture"`
	// Region 为图集内的归一化矩形 [u,v,width,height]，原点在顶部。
	Region      [4]float32 `json:"region"`
	Mode        Mode       `json:"mode"`
	DoubleSided bool       `json:"doubleSided"`
	Unlit       bool       `json:"unlit"`
	Opacity     float32    `json:"opacity"`
	// 图集帧信息；静态纹理为 1 帧、0 tick。
	Frames    int `json:"frames"`
	FrameTime int `json:"frameTime"`
}
