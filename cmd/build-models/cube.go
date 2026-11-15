package main

import (
	"image"
	"image/png"
	"math"
	"os"
)

// surfaceGrid 描述 surfaces.png 的排布：每张 16×16 贴图连同各级 mip 占一个 32×16 的网格单元，
// 第 k 级边长 16>>k，位于单元内 x=2·(16-边长) 处。自左向右、自上而下编号即为纹理数组的层号。
type surfaceGrid struct {
	Width, Height float64
	image         *image.NRGBA
}

const (
	surfaceCell = 32
	surfaceSide = 16
)

func openSurfaceGrid(path string) (surfaceGrid, error) {
	f, err := os.Open(path)
	if err != nil {
		return surfaceGrid{}, err
	}
	defer f.Close()
	decoded, err := png.Decode(f)
	if err != nil {
		return surfaceGrid{}, err
	}
	pixels := image.NewNRGBA(decoded.Bounds())
	for y := range decoded.Bounds().Dy() {
		for x := range decoded.Bounds().Dx() {
			pixels.Set(x, y, decoded.At(x, y))
		}
	}
	return surfaceGrid{Width: float64(pixels.Rect.Dx()), Height: float64(pixels.Rect.Dy()), image: pixels}, nil
}

// writeLayers 输出纹理数组的全部 mip 级：逐级连续存放，每级内逐层存放 RGBA8。
// 颜色先转线性再乘 alpha，最后编码回 sRGB；GPU 以 SRGB8_ALPHA8 读取时得到线性预乘色，
// 硬件过滤因此等价于按不透明度加权平均，透明像素的底色不会渗进相邻纹素。
func (g surfaceGrid) writeLayers(path string, layers int) error {
	var data []byte
	columns := int(g.Width) / surfaceCell
	for size := surfaceSide; size >= 1; size /= 2 {
		for layer := range layers {
			x0 := layer%columns*surfaceCell + 2*(surfaceSide-size)
			y0 := layer / columns * surfaceSide
			for y := range size {
				for x := range size {
					c := g.image.NRGBAAt(x0+x, y0+y)
					a := float64(c.A) / 255
					for _, v := range []uint8{c.R, c.G, c.B} {
						data = append(data, srgbByte(float64(linear(float32(v)/255))*a))
					}
					data = append(data, c.A)
				}
			}
		}
	}
	return os.WriteFile(path, data, 0644)
}

// hasHoles 判断某层第 0 级贴图是否有接近全透明的像素。
func (g surfaceGrid) hasHoles(layer int) bool {
	columns := int(g.Width) / surfaceCell
	x0, y0 := layer%columns*surfaceCell, layer/columns*surfaceSide
	for y := range surfaceSide {
		for x := range surfaceSide {
			if g.image.NRGBAAt(x0+x, y0+y).A < 128 {
				return true
			}
		}
	}
	return false
}

func srgbByte(v float64) uint8 {
	if v <= 0.0031308 {
		v *= 12.92
	} else {
		v = 1.055*math.Pow(v, 1/2.4) - 0.055
	}
	return uint8(math.Round(math.Max(0, math.Min(1, v)) * 255))
}

// encodeCubeFace 把旧的图集坐标换成纹理数组坐标。输出 16 个浮点：
// 贴图空间原点与 u 方向、v 方向与层号（-1 表示纯色）与标志、线性色调与不透明度系数、代表色。
// 原始 12 项依次为：图集原点、u 方向、v 方向、sRGB 色调 rg、色调 b、贴图边长、不透明度系数、标志。
func encodeCubeFace(grid surfaceGrid, values [12]float32, representative [4]byte) [16]float32 {
	tint := [3]float32{linear(values[6]), linear(values[7]), linear(values[8])}
	color := [4]float32{float32(representative[0]) / 255, float32(representative[1]) / 255, float32(representative[2]) / 255, float32(representative[3]) / 255}
	if values[9] == 0 {
		return [16]float32{0, 0, 0, 0, 0, 0, -1, values[11], tint[0], tint[1], tint[2], values[10], color[0], color[1], color[2], color[3]}
	}
	var origin, extent, o, du, dv [2]float64
	for a := range 2 {
		origin[a] = float64(values[a]) + math.Min(float64(values[2+a]), 0) + math.Min(float64(values[4+a]), 0)
		extent[a] = math.Abs(float64(values[2+a])) + math.Abs(float64(values[4+a]))
		o[a] = (float64(values[a]) - origin[a]) / extent[a]
		du[a] = float64(values[2+a]) / extent[a]
		dv[a] = float64(values[4+a]) / extent[a]
	}
	column := math.Round(origin[0] * grid.Width / surfaceCell)
	row := math.Round(origin[1] * grid.Height / float64(values[9]))
	layer := row*math.Floor(grid.Width/surfaceCell) + column
	return [16]float32{
		float32(o[0]), float32(o[1]), float32(du[0]), float32(du[1]),
		float32(dv[0]), float32(dv[1]), float32(layer), values[11],
		tint[0], tint[1], tint[2], values[10],
		color[0], color[1], color[2], color[3],
	}
}

// linear 把 sRGB 色调转为线性；贴图在 GPU 上按线性采样，色调直接相乘。
func linear(c float32) float32 {
	v := float64(c)
	if v <= 0.04045 {
		return float32(v / 12.92)
	}
	return float32(math.Pow((v+0.055)/1.055, 2.4))
}
