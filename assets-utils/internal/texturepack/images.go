package texturepack

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io/fs"
	"math"
	"strings"
)

// tile 并列保存颜色与数据图，法线和高光通道不经过颜色转换或 alpha 预乘。
type tile struct {
	color    *image.NRGBA
	normal   *image.NRGBA
	specular *image.NRGBA
}

// decodePNG 保留未预乘通道，法线和高光图片的 A 不表示透明度。
func decodePNG(data []byte) (*image.NRGBA, error) {
	source, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	result := image.NewNRGBA(source.Bounds())
	draw.Draw(result, result.Bounds(), source, source.Bounds().Min, draw.Src)
	return result, nil
}

// firstFrame 按 frames 列表选取动画首帧，支持横向帧和显式宽高。
func firstFrame(source *image.NRGBA, metadata []byte) (*image.NRGBA, error) {
	var meta struct {
		Animation *struct {
			Width  int
			Height int
			Frames []json.RawMessage
		}
	}
	if len(metadata) == 0 {
		return source, nil
	}
	if err := json.Unmarshal(metadata, &meta); err != nil {
		return nil, err
	}
	if meta.Animation == nil {
		return source, nil
	}
	a := meta.Animation
	w := a.Width
	h := a.Height
	if w == 0 && h == 0 {
		w = min(source.Rect.Dx(), source.Rect.Dy())
		h = w
	} else if w == 0 {
		w = source.Rect.Dx()
	} else if h == 0 {
		h = source.Rect.Dy()
	}
	index := 0
	if len(a.Frames) > 0 {
		if err := json.Unmarshal(a.Frames[0], &index); err != nil {
			var frame struct{ Index int }
			if err = json.Unmarshal(a.Frames[0], &frame); err != nil {
				return nil, err
			}
			index = frame.Index
		}
	}
	if w <= 0 || h <= 0 || w > source.Rect.Dx() || index < 0 {
		return nil, fs.ErrInvalid
	}
	columns := source.Rect.Dx() / w
	rect := image.Rect(
		index%columns*w,
		index/columns*h,
		index%columns*w+w,
		index/columns*h+h,
	)
	if !rect.In(source.Rect) {
		return nil, fs.ErrInvalid
	}
	result := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.Draw(result, result.Rect, source, rect.Min, draw.Src)
	return result, nil
}

// readTile 读取材质包首帧，配套数据图可沿用颜色图的动画元数据。
// 缺失或坏图由调用方使用原版或默认值。
func readTile(pack fs.FS, name, suffix string) *image.NRGBA {
	if pack == nil {
		return nil
	}
	namespace, path, _ := strings.Cut(name, ":")
	base := "assets/" + namespace + "/textures/" + path
	data, err := fs.ReadFile(pack, base+suffix+".png")
	if err != nil {
		return nil
	}
	source, err := decodePNG(data)
	if err != nil {
		return nil
	}
	meta, _ := fs.ReadFile(pack, base+suffix+".png.mcmeta")
	if len(meta) == 0 && suffix != "" {
		meta, _ = fs.ReadFile(pack, base+".png.mcmeta")
	}
	result, err := firstFrame(source, meta)
	if err != nil {
		return nil
	}
	return result
}

// solid 用单个像素表示默认材质，采样时自然扩展到整层。
func solid(pixel color.NRGBA) *image.NRGBA {
	result := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	result.SetNRGBA(0, 0, pixel)
	return result
}

// sample 用归一化坐标取最近点，让三张不同分辨率的源图共用采样位置。
func sample(img *image.NRGBA, u, v float64) color.NRGBA {
	x := min(img.Rect.Dx()-1, max(0, int(u*float64(img.Rect.Dx()))))
	y := min(img.Rect.Dy()-1, max(0, int(v*float64(img.Rect.Dy()))))
	return img.NRGBAAt(x, y)
}

// linear 把颜色转换到亮度空间，避免平均缩小时变暗。
func linear(v byte) float64 {
	f := float64(v) / 255
	if f <= .04045 {
		return f / 12.92
	}
	return math.Pow((f+.055)/1.055, 2.4)
}

// srgb 仅编码颜色通道，数据图不会经过这里。
func srgb(v float64) byte {
	if v <= .0031308 {
		v *= 12.92
	} else {
		v = 1.055*math.Pow(v, 1/2.4) - .055
	}
	return byte(math.Round(min(1, max(0, v)) * 255))
}

// compose 按颜色 alpha 合成三张图，避免把数据图的高度或自发光 A 通道当成透明度。
func compose(parts []Part, tiles map[string]tile, side int) tile {
	result := tile{
		color:    image.NewNRGBA(image.Rect(0, 0, side, side)),
		normal:   image.NewNRGBA(image.Rect(0, 0, side, side)),
		specular: image.NewNRGBA(image.Rect(0, 0, side, side)),
	}
	for y := range side {
		for x := range side {
			c := color.NRGBA{}
			n := color.NRGBA{128, 128, 255, 255}
			s := color.NRGBA{}
			for _, p := range parts {
				u := (float64(x) + .5) / float64(side)
				v := (float64(y) + .5) / float64(side)
				tu := p.UV[0] + u*p.UV[2] + v*p.UV[4]
				tv := p.UV[1] + u*p.UV[3] + v*p.UV[5]
				t := tiles[p.Texture]
				front := sample(t.color, tu, tv)
				if p.Cutout && front.A < 26 {
					continue
				}
				if len(parts) > 1 && p.Cutout {
					front.A = 255
				}
				a := float64(front.A) / 255
				b := float64(c.A) / 255
				alpha := a + b*(1-a)
				if alpha > 0 {
					c.R = srgb((linear(front.R)*float64(p.Tint[0])*a + linear(c.R)*b*(1-a)) / alpha)
					c.G = srgb((linear(front.G)*float64(p.Tint[1])*a + linear(c.G)*b*(1-a)) / alpha)
					c.B = srgb((linear(front.B)*float64(p.Tint[2])*a + linear(c.B)*b*(1-a)) / alpha)
				}
				c.A = byte(math.Round(alpha * 255))
				if len(parts) == 1 || a > 0 {
					n = sample(t.normal, tu, tv)
					s = sample(t.specular, tu, tv)
				}
			}
			result.color.SetNRGBA(x, y, c)
			result.normal.SetNRGBA(x, y, n)
			result.specular.SetNRGBA(x, y, s)
		}
	}
	return result
}

// mipBytes 在线性预乘空间连续平均；只在写出各级时量化，数据通道则直接平均。
func mipBytes(img *image.NRGBA, colorData bool) [][]byte {
	side := img.Rect.Dx()
	values := make([]float64, side*side*4)
	for i, v := range img.Pix {
		values[i] = float64(v) / 255
	}
	if colorData {
		for i := 0; i < len(values); i += 4 {
			for c := range 3 {
				values[i+c] = linear(img.Pix[i+c]) * values[i+3]
			}
		}
	}
	var levels [][]byte
	for {
		data := make([]byte, len(values))
		for i, v := range values {
			if colorData && i%4 != 3 {
				data[i] = srgb(v)
			} else {
				data[i] = byte(math.Round(v * 255))
			}
		}
		levels = append(levels, data)
		if side == 1 {
			break
		}
		nextSide := max(1, side/2)
		next := make([]float64, nextSide*nextSide*4)
		for y := range nextSide {
			for x := range nextSide {
				for c := range 4 {
					for dy := range 2 {
						for dx := range 2 {
							next[(y*nextSide+x)*4+c] += values[((y*2+dy)*side+x*2+dx)*4+c] / 4
						}
					}
				}
			}
		}
		side = nextSide
		values = next
	}
	return levels
}

// holes 按该类表面着色器的裁切阈值判断透明孔，供模型分类使用。
func holes(img *image.NRGBA, threshold byte) bool {
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] < threshold {
			return true
		}
	}
	return false
}

// resize 放大用最近点；缩小时按覆盖面积平均，颜色先线性预乘，数据四通道直接平均。
func resize(source *image.NRGBA, width, height int, colorData bool) *image.NRGBA {
	result := image.NewNRGBA(image.Rect(0, 0, width, height))
	sw := source.Rect.Dx()
	sh := source.Rect.Dy()
	for y := range height {
		for x := range width {
			if width >= sw && height >= sh {
				result.SetNRGBA(
					x,
					y,
					sample(
						source,
						(float64(x)+.5)/float64(width),
						(float64(y)+.5)/float64(height),
					),
				)
				continue
			}
			x0 := float64(x*sw) / float64(width)
			x1 := float64((x+1)*sw) / float64(width)
			y0 := float64(y*sh) / float64(height)
			y1 := float64((y+1)*sh) / float64(height)
			var sum [4]float64
			weight := 0.0
			for sy := int(y0); sy < int(math.Ceil(y1)); sy++ {
				for sx := int(x0); sx < int(math.Ceil(x1)); sx++ {
					area := (min(x1, float64(sx+1)) - max(x0, float64(sx))) * (min(y1, float64(sy+1)) - max(y0, float64(sy)))
					p := source.NRGBAAt(sx, sy)
					values := [4]float64{
						float64(p.R) / 255,
						float64(p.G) / 255,
						float64(p.B) / 255,
						float64(p.A) / 255,
					}
					if colorData {
						values[0] = linear(p.R) * values[3]
						values[1] = linear(p.G) * values[3]
						values[2] = linear(p.B) * values[3]
					}
					for c := range 4 {
						sum[c] += values[c] * area
					}
					weight += area
				}
			}
			var pixel [4]byte
			for c := range 4 {
				if colorData && c < 3 {
					if sum[3] > 0 {
						pixel[c] = srgb(sum[c] / sum[3])
					}
				} else {
					pixel[c] = byte(math.Round(sum[c] / weight * 255))
				}
			}
			result.SetNRGBA(x, y, color.NRGBA{pixel[0], pixel[1], pixel[2], pixel[3]})
		}
	}
	return result
}

// layerColor 分别保存不透明面的裁切覆盖率与混合面的真实 alpha 统计。
type layerColor struct {
	rgb   [2][3]float64
	alpha [2]float64
}

// measureLayer 为每层预先统计颜色与覆盖率，引用它的立方体再应用各自染色与不透明度。
func measureLayer(img *image.NRGBA) layerColor {
	var result layerColor
	for i := 0; i < len(img.Pix); i += 4 {
		alpha := [2]float64{0, float64(img.Pix[i+3]) / 255}
		if img.Pix[i+3] >= 128 {
			alpha[0] = 1
		}
		for mode := range 2 {
			result.alpha[mode] += alpha[mode]
			for c := range 3 {
				result.rgb[mode][c] += linear(img.Pix[i+c]) * alpha[mode]
			}
		}
	}
	for mode := range 2 {
		if result.alpha[mode] > 0 {
			for c := range 3 {
				result.rgb[mode][c] /= result.alpha[mode]
			}
		}
		result.alpha[mode] /= float64(img.Rect.Dx() * img.Rect.Dy())
	}
	return result
}
