const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
function convert(name, output) {
  const picking = name.endsWith("-pick");
  const program = name.replace(/-(pick|retry)$/, "");
  const tier = program === "photo" ? "accumulation" : program;
  const compute = tier === "shading" || tier === "accumulation";
  const tierNumber = ["voxel", "basic", "shading", "accumulation"].indexOf(tier);
  if (tierNumber < 0) throw Error("Unknown render tier " + tier);
  const singleBounce = program === "accumulation";
  const uniforms = [];
  // Binding 0 contains uniforms, binding 3 the region pool, and binding 14 the sampler.
  const textures = {
    uSections: 1,
    uTree: 2,
    uModels: 4,
    uFast: 5,
    uQuadReferences: 6,
    uQuadRecords: 7,
    uAtlas: 8,
    uAtlasSpecular: 9,
    uSurfaces: 10,
    uSurfaceSpecular: 11,
    uAtlasNormals: 12,
    uSurfaceNormals: 13,
    uVoxels: 15,
    uObjectData: 16,
    uObjectAtlas: 17,
  };
  let source = fs
    .readFileSync(path.join(root, "src/render/ray.frag"), "utf8")
    .replace("#include <objects>", fs.readFileSync(path.join(root, "src/render/objects.frag"), "utf8"))
    .replace(
      "#version 300 es",
      `#version 450
#extension GL_EXT_samplerless_texture_functions : require
#define R2_CUBE_PASS ${Number(compute && !name.endsWith("-retry"))}
#define R2_DIRECT_LOOKUP ${Number(compute)}
#define R2_COMPACT_CELLS 0
#define RENDER_TIER ${tierNumber}
#define R2_PICK ${Number(picking)}
#define R2_ONE_BOUNCE ${Number(singleBounce)}
layout(binding=14) uniform sampler tiles;
layout(std140,binding=0) uniform Inputs { vec4 values[64]; } frame;`,
    )
    .replace(/^precision .*;/gm, "")
    .replace("out vec4 outColor;", "layout(location=0) out vec4 outColor;")
    .replaceAll("gl_FragCoord.xy", "vec2(gl_FragCoord.x,uViewport.y-gl_FragCoord.y)")
    .replace("vec4 table(sampler2D source", "vec4 table(texture2D source")
    .replace(/^uniform (\w+) ([\w,]+);/gm, (_, type, names) =>
      names
        .split(",")
        .map((name) => {
          if (name === "uBounces" && singleBounce) return "";
          if (name === "uWorldData")
            return "layout(std430,binding=3) readonly buffer Pool { uint words[]; };";
          if (type.includes("sampler")) {
            if (!(name in textures)) throw Error("Unknown texture " + name);
            return `layout(binding=${textures[name]}) uniform ${type.replace("sampler", "texture")} ${name};`;
          }
          const index = uniforms.push(name) - 1;
          const swizzle = type.endsWith("3") ? "xyz" : type.endsWith("2") ? "xy" : "x";
          return `#define ${name} ${type}(frame.values[${index}].${swizzle})`;
        })
        .join("\n"),
    );
  source = source.replace(
    /uint worldWord\(uint offset\)\{[^}]+\}/,
    "uint worldWord(uint offset){return words[offset];}",
  );
  {
    // Four logical tiles per array layer keep the material within the mobile layer limit.
    source = source
      .replaceAll("textureSize(uSurfaces,0).x", "(textureSize(uSurfaces,0).x/2)")
      .replace(/textureLod\((uSurface\w+),/g, "sampleTile($1,");
    const helper = `vec4 sampleTile(texture2DArray image,vec3 p,float lod){
    int layer=int(p.z); vec2 tile=vec2(layer&1,(layer>>1)&1);
    return textureLod(sampler2DArray(image,tiles),vec3((fract(p.xy)+tile)*.5,layer>>2),lod);
  }`;
    source = source.replace("vec4 surfaceTexel(", helper + "\nvec4 surfaceTexel(");
  }
  {
    // A previous-frame texture keeps 32-bit precision without requiring optional float blending.
    source = source
      .replace(
        "layout(std140,binding=0)",
        "layout(set=1,binding=0) uniform texture2D history;\nlayout(std140,binding=0)",
      )
      .replace("uint(gl_FragCoord.y)", "uint(uViewport.y-gl_FragCoord.y)")
      .replace("textureLod(uObjectAtlas,", "textureLod(sampler2D(uObjectAtlas,tiles),")
      .replace(
        "outColor=vec4(color,1.0);",
        "outColor=vec4(color,1.0); if(frame.values[63].x>0.0) outColor+=texelFetch(history,ivec2(gl_FragCoord.xy),0);",
      );
  }
  // 光影和累积在计算管线中逐像素写 HDR。照片的分块起点放在保留的 uniform 62。
  if (compute) {
    source = source
      .replace("layout(location=0) out vec4 outColor;", `layout(local_size_x=8,local_size_y=4) in;
layout(set=2,binding=0,rgba32f) uniform writeonly image2D outputHDR;
layout(std430,set=2,binding=1) buffer RetryMask { uint retryMask[]; };
vec4 outColor;
vec4 pixelCoord;`)
      .replaceAll("gl_FragCoord", "pixelCoord")
      .replace("void main(){", "void shadePixel(){");
    source += `
void main(){
  ivec2 pixel=ivec2(gl_GlobalInvocationID.xy)+ivec2(frame.values[62].xy);
  if(any(greaterThanEqual(pixel,imageSize(outputHDR))))return;
  // 一个工作组恰好 32 个像素，用一个字记录需要完整求交的像素。
  uint word=gl_WorkGroupID.x+gl_WorkGroupID.y*gl_NumWorkGroups.x;
  uint bit=1u<<gl_LocalInvocationIndex;
#if !R2_CUBE_PASS
  if((retryMask[word]&bit)==0u)return;
#endif
  pixelCoord=vec4(vec2(pixel)+0.5,0,1);
  shadePixel();
#if R2_CUBE_PASS
  if(needsFullModel){atomicOr(retryMask[word],bit);return;}
#endif
  imageStore(outputHDR,pixel,outColor);
}`;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "r2-wgsl-"));
  try {
    const spv = require("@webgpu/glslang")().compileGLSL(source, compute ? "compute" : "fragment", false);
    fs.writeFileSync(path.join(temp, "ray.spv"), Buffer.from(spv.buffer, spv.byteOffset, spv.byteLength));
    execFileSync(process.execPath, [require.resolve("naga-wasi-cli/bin/naga.mjs"), "ray.spv", "ray.wgsl"], {
      cwd: temp,
      stdio: "inherit",
    });
    fs.writeFileSync(
      path.join(output, name + ".wgsl"),
      "// Generated by webgl2gpu/convert.cjs\n// Uniform slots: " +
        uniforms.join(",") +
        "\n" +
        fs.readFileSync(path.join(temp, "ray.wgsl"), "utf8"),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = {convert};
if(require.main===module){
  const output = path.join(root, "dist/render");
  fs.mkdirSync(output, {recursive:true});
  for(const name of ["voxel","basic","shading","shading-retry","accumulation","accumulation-retry","photo","photo-retry","voxel-pick","basic-pick"])convert(name,output);
}
