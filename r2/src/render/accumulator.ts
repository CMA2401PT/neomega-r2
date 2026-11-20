// 泛光的起点：把累积结果缩到一半尺寸，之后由 mipmap 逐级模糊。
// 太阳圆盘或偶发的极亮样本会把整片光晕染色，先限制亮度。
const PREFILTER = `#version 300 es
precision highp float;
uniform sampler2D uImage;
out vec4 outColor;
// 宽或高为 1 时，相邻纹素落在图像外；夹到边缘，避免 0/0 污染整幅画面。
vec3 texel(ivec2 p){vec4 s=texelFetch(uImage,min(p,textureSize(uImage,0)-1),0);return min(s.rgb/s.a,vec3(50));}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy)*2;
 outColor=vec4((texel(p)+texel(p+ivec2(1,0))+texel(p+ivec2(0,1))+texel(p+1))*.25,1);
}`;
const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uImage,uBloom;
uniform float uExposure;
uniform bool uRaw;
out vec4 outColor;
vec3 srgbColor(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,greaterThan(c,vec3(0.0031308)));}
// ACES 的常用拟合：高光平滑压到白色，暗部略提对比。
vec3 aces(vec3 x){return clamp(x*(2.51*x+.03)/(x*(2.43*x+.59)+.14),0.0,1.0);}
// 镜头里的散射：几级模糊叠加成由近到远衰减的光晕。每级取四个错开半个纹素的点，盖住 mipmap 的方块边。
vec3 bloom(vec2 uv){
 vec3 sum=vec3(0);
 for(int level=1;level<=6;level++){
  vec2 step=.5/vec2(textureSize(uBloom,level));
  sum+=textureLod(uBloom,uv+vec2(-step.x,-step.y),float(level)).rgb+textureLod(uBloom,uv+vec2(step.x,-step.y),float(level)).rgb
   +textureLod(uBloom,uv+vec2(-step.x,step.y),float(level)).rgb+textureLod(uBloom,uv+vec2(step.x,step.y),float(level)).rgb;
 }
 return sum/24.0;
}
void main(){
 vec4 sum=texelFetch(uImage,ivec2(gl_FragCoord.xy),0);
 vec3 color=sum.rgb/sum.a;
 if(uRaw){outColor=vec4(color,1);return;}
 color=mix(color,bloom(gl_FragCoord.xy/vec2(textureSize(uImage,0))),BLOOM);
 outColor=vec4(srgbColor(aces(color*uExposure)),1);
}`;
// 与 WebGPU 使用同一个 3×3 双边核。比较已完成色调映射的颜色，保留 35% 的原像素。
const DENOISE = `#version 300 es
precision highp float;
uniform highp sampler2D uImage;
out vec4 outColor;
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy),edge=textureSize(uImage,0)-1;
 vec3 center=texelFetch(uImage,p,0).rgb,sum=center;
 float total=1.0;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  if(x==0&&y==0)continue;
  vec3 color=texelFetch(uImage,clamp(p+ivec2(x,y),ivec2(0),edge),0).rgb;
  vec3 delta=(color-center)*(255.0/4.0);
  float weight=exp(-.5*(float(x*x+y*y)/(.85*.85)+dot(delta,delta)/3.0));
  sum+=color*weight;
  total+=weight;
 }
 outColor=vec4(mix(center,sum/total,.65),1);
}`;
// 光晕在最终画面里的占比。
const BLOOM = 0.075;
// 显示时读取的两张缓冲放在射线程序用不到的单元上，射线程序已绑定的贴图不受影响。
const UNIT = 15,
  BLOOM_UNIT = 16;

/** 射线着色器每帧输出 (线性亮度×权重, 权重)。画面变化时预览帧覆盖缓冲，静止后的样本逐帧相加；
 * 显示时除以总权重，再做曝光与色调映射。这样实时画面和静止后的收敛画面走同一条路径。
 * 32 位浮点缓冲与浮点混合需要 EXT_color_buffer_float 和 EXT_float_blend。
 * @param gl
 * @param vertexSource 全屏三角形的顶点着色器
 */
export function createAccumulator(gl: WebGL2RenderingContext, vertexSource: string) {
  gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("EXT_float_blend");
  function compile(fragmentSource: string): WebGLProgram {
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw Error("无法创建着色器");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader) ?? "着色器编译失败");
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program) ?? "着色器链接失败");
    return program;
  }
  const denoiseProgram = compile(DENOISE),
    prefilter = compile(PREFILTER),
    program = compile(COMPOSITE.replace("BLOOM", BLOOM.toFixed(3)));
  const location = (name: string) => gl.getUniformLocation(program, name);
  const exposure = location("uExposure"),
    raw = location("uRaw");
  gl.useProgram(denoiseProgram);
  gl.uniform1i(gl.getUniformLocation(denoiseProgram, "uImage"), UNIT);
  gl.useProgram(prefilter);
  gl.uniform1i(gl.getUniformLocation(prefilter, "uImage"), UNIT);
  gl.useProgram(program);
  gl.uniform1i(location("uImage"), UNIT);
  gl.uniform1i(location("uBloom"), BLOOM_UNIT);
  let texture: WebGLTexture | null = null,
    framebuffer: WebGLFramebuffer | null = null,
    // 半尺寸、带完整 mipmap 的泛光缓冲。
    glow: WebGLTexture | null = null,
    glowFramebuffer: WebGLFramebuffer | null = null,
    filterImage: WebGLTexture | null = null,
    filterFramebuffer: WebGLFramebuffer | null = null,
    width = 0,
    height = 0,
    // 当前画面已经相加的累积样本数，不含预览帧。
    samples = 0;

  /** 尺寸变化时重建缓冲。 */
  function resize(w: number, h: number): void {
    if (w === width && h === height) return;
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(glow);
    gl.deleteFramebuffer(glowFramebuffer);
    gl.deleteTexture(filterImage);
    gl.deleteFramebuffer(filterFramebuffer);
    filterImage = null;
    filterFramebuffer = null;
    width = w;
    height = h;
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    const glowWidth = Math.max(1, w >> 1),
      glowHeight = Math.max(1, h >> 1);
    glow = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + BLOOM_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, glow);
    gl.texStorage2D(
      gl.TEXTURE_2D,
      Math.floor(Math.log2(Math.max(glowWidth, glowHeight))) + 1,
      gl.RGBA16F,
      glowWidth,
      glowHeight,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    glowFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, glowFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      glow,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    samples = 0;
  }

  /** 把累积缓冲合成为显示色，按所选档位平滑后写入目标画面。 */
  function composite(target: WebGLFramebuffer | null, value: number, debug: boolean, denoise: boolean): void {
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    const filter = denoise && !debug;
    if (filter && !filterImage) {
      filterImage = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, filterImage);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      filterFramebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, filterFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, filterImage, 0);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.activeTexture(gl.TEXTURE0 + BLOOM_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, glow);
    gl.bindFramebuffer(gl.FRAMEBUFFER, glowFramebuffer);
    gl.viewport(0, 0, Math.max(1, width >> 1), Math.max(1, height >> 1));
    gl.useProgram(prefilter);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, filter ? filterFramebuffer : target);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.uniform1f(exposure, value);
    gl.uniform1i(raw, Number(debug));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (filter) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.activeTexture(gl.TEXTURE0 + UNIT);
      gl.bindTexture(gl.TEXTURE_2D, filterImage);
      gl.useProgram(denoiseProgram);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  return {
    resize,
    /** 让随后的射线绘制写入缓冲；返回这一帧的通道：0 预览（覆盖），1 累积（相加）。
     * @param accumulate 画面与上一帧完全相同时为真
     */
    begin(accumulate: boolean): 0 | 1 {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      if (accumulate) {
        samples++;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        return 1;
      }
      samples = 0;
      gl.disable(gl.BLEND);
      return 0;
    },
    /** 清空缓冲，随后的样本全部以累积方式相加。 */
    clear() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      samples = 0;
    },
    /** 把缓冲显示到画布。 */
    present({ exposure, raw, denoise }: { exposure: number; raw: boolean; denoise: boolean }): void {
      composite(null, exposure, raw, denoise);
    },
    /** 色调映射后读回 8 位 RGBA，第一行在画面底部。 */
    read({ exposure, denoise }: { exposure: number; denoise: boolean }): Uint8Array {
      const target = gl.createTexture(),
        output = gl.createFramebuffer(),
        pixels = new Uint8Array(width * height * 4);
      // 临时贴图也放在本模块的单元上，不打乱射线程序已绑定的贴图。
      gl.activeTexture(gl.TEXTURE0 + UNIT);
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, output);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        target,
        0,
      );
      composite(output, exposure, false, denoise);
      gl.bindFramebuffer(gl.FRAMEBUFFER, output);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(output);
      gl.deleteTexture(target);
      return pixels;
    },
    get samples() {
      return samples;
    },
    get bytes() {
      // 累积缓冲每像素 16 字节；半尺寸的泛光缓冲连同 mipmap 约为每像素 8×¼×4/3 字节。
      return width * height * (filterImage ? 20 : 16) + Math.round((width * height * 8) / 3);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(glow);
      gl.deleteFramebuffer(glowFramebuffer);
      gl.deleteFramebuffer(filterFramebuffer);
      gl.deleteTexture(filterImage);
      gl.deleteProgram(denoiseProgram);
      gl.deleteProgram(prefilter);
      gl.deleteProgram(program);
    },
  };
}

export type Accumulator = ReturnType<typeof createAccumulator>;
