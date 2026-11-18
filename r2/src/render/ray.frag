#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
precision highp usampler2D;
precision highp sampler2DArray;
// 世界数据：每个 section 一项的循环目录、目录之上的均匀层次、存放附加块与压缩索引的区域池。
uniform usampler3D uSections,uTree;
uniform usampler2D uWorldData;
uniform ivec3 uDirectoryOffset;
// 共享模型：模型头、四边形引用与记录、完整方块面表与面贴图数组、复杂模型图集。
uniform usampler2D uModels,uQuadReferences;
uniform sampler2D uQuadRecords,uFast,uAtlas,uAtlasNormals,uAtlasSpecular;
// 材质包的三套同布局贴图：颜色、labPBR 法线（_n）与高光（_s）。缺图时取默认值，原版灯块由资源合成器补自发光。
uniform sampler2DArray uSurfaces,uSurfaceNormals,uSurfaceSpecular;
uniform vec3 uSize,uCamera,uRight,uUp,uForward;
uniform vec2 uViewport;
uniform float uSpan;
uniform bool uOrtho,uHasWorld,uPicking;
uniform vec2 uPickPixel;
vec3 firstNormal;
uniform int uDebug;
uniform bool uHierarchy,uFragments;
// 指向太阳的单位向量；太阳落到地平线下以后由反方向的月亮照明。
uniform vec3 uSun;
// 四档绘制器各自编译，低档用预处理去掉整段代码，弱设备只需编译、执行自己那一档：
// 0 体素：每个非空格子都是纯色立方体，水与玻璃是透明纯色块；无阴影、无雾、无水面效果。
// 1 基础：完整的方块形状与贴图，水只是像玻璃一样的透明面；无阴影、无雾、无水面效果与反射、无 PBR。
// 2 光影：硬阴影、远景雾、水面波纹与反射、labPBR 材质；单帧预览的最高档。
// 3 累积：在光影之上加像素内抖动、软阴影与漫反射反弹，静止累积与拍照专用。
#ifndef RENDER_TIER
#define RENDER_TIER 2
#endif
const int uPass=RENDER_TIER==3?1:0;
// 预览档的像素内偏移（像素）；导出时按网格超采样，单帧预览为零。累积档自己随机抖动。
uniform vec2 uJitter;
uniform uint uFrame,uWaterGroup;
// 静止水源的模型编号；低档把无限海面画成一层与它同色的透明平面。
uniform uint uWater;
#if RENDER_TIER==0
// 体素档的每模型代表色：每个模型两项，线性颜色与不透明度、自发光强度。
uniform sampler2D uVoxels;
#endif
// 远景雾在这个距离上接近不透明，遮住观察窗口的边界。
uniform float uFog;
// 秒；宿主固定时间后累积同一个波面，动画时重开预览。
uniform float uTime;
// 海面独立于体素窗口；波纹使用世界坐标，窗口移动时相位不变。
uniform bool uOcean;
uniform float uOceanHeight;
uniform vec3 uWorldOrigin;
// 累积样本的漫反射反弹次数：实时累积为 1，拍照时更多。
uniform int uBounces;
out vec4 outColor;
const uint MIXED=0xffffffffu;
const float EPS=0.00002;
// 附加块布局：128 字格子掩码、64 字小块标签、1 字片段表地址，随后是调色板。
const uint AUX_TAGS=128u,AUX_PARTS=192u,AUX_PALETTE=193u;
// eye 是当前射线的起点：主射线为相机，阴影与反弹射线为命中点；遍历与求交都只读它。
vec3 eye,ray,invRay;
// 合成结果：radiance 已含环境光与自发光，directSum 等待乘阴影射线的可见度，throughput 是剩余的透过率。
vec3 radiance,directSum,throughput;
// 两个代表表面：权重最大的受光面向光源发阴影射线；累积时，权重最大的任意面做一次漫反射反弹。
// 反弹面另记镜面部分的权重（透过率×菲涅耳）、着色法线与入射方向，累积时按两者的大小选择漫反射或镜面方向。
// bounceAmbient 是反弹面已经计入的常量环境光，反弹时用实际看到的亮度把它换掉。
vec3 shadePoint,shadeNormal,bouncePoint,bounceNormal,bounceAlbedo,bounceAmbient,bounceSpecular,bounceShading,bounceView;
float bounceRoughness;
float shadeWeight,bounceWeight;
// 本像素的光照：光源方向与亮度（白天为太阳，夜间为月亮），以及来自天空的常量环境光。
vec3 lightDir,lightColor,ambient;
// rayLength 是未归一化方向的长度，用于把屏幕上一个像素换算成表面上的足迹；反弹射线没有像素足迹。
float firstDepth,rayLength,primaryTravel;
bool primaryRay;
// 射线进入水体的位置，负数表示不在水中。
float waterFrom;
// 主射线第一次从上方落到水面的位置与当时的透过率，以及此前已经合成的部分；水面反射在这里分出一条射线。
vec3 mirrorPoint,mirrorWeight,mirrorRadiance,mirrorDirect;
bool mirrored;
// 树冠遮光：射线每穿过一格树叶的空隙就变暗一些，近似游戏里树叶逐格削弱天光；离开树冠后恢复。
float foliage;
int steps,faceTests;
bool touched;
uint seed;
vec3 linearColor(vec3 c){return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),greaterThan(c,vec3(0.04045)));}
float brightest(vec3 v){return max(v.r,max(v.g,v.b));}
uint pcg(uint v){uint s=v*747796405u+2891336453u;uint w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
float random(){seed=pcg(seed);return float(seed)/4294967296.0;}
// 以 d 为轴的锥内均匀方向；半径是锥角的正切。
vec3 coneDirection(vec3 d,float radius){
 vec3 t=normalize(cross(d,abs(d.y)<.99?vec3(0,1,0):vec3(1,0,0))),b=cross(d,t);
 float r=radius*sqrt(random()),a=6.2831853*random();
 return normalize(d+(t*cos(a)+b*sin(a))*r);
}
// 余弦加权的半球方向：漫反射表面的反弹按它取样，估计值就是 反照率×来向亮度。
vec3 cosineDirection(vec3 n){
 vec3 t=normalize(cross(n,abs(n.y)<.99?vec3(0,1,0):vec3(1,0,0))),b=cross(n,t);
 float r=sqrt(random()),a=6.2831853*random();
 return normalize((t*cos(a)+b*sin(a))*r+n*sqrt(max(0.0,1.0-r*r)));
}
// 天空亮度：白天天顶深蓝、地平线浅；太阳接近地平线时，朝太阳一侧偏橙；夜间只剩暗蓝。
vec3 skyRadiance(vec3 d){
 float day=smoothstep(-.15,.3,uSun.y),up=clamp(d.y,0.0,1.0);
 vec3 zenith=mix(vec3(.002,.003,.008),vec3(.08,.16,.34),day);
 vec3 horizon=mix(vec3(.006,.008,.014),vec3(.42,.55,.72),day);
 vec3 toward=normalize(vec3(uSun.x,0,uSun.z)+vec3(1e-4));
 float dusk=day*(1.0-smoothstep(0.0,.35,uSun.y))*pow(max(dot(d,toward),0.0),4.0)*(1.0-up)*(1.0-up);
 return mix(horizon,zenith,sqrt(up))+dusk*vec3(.6,.25,.08);
}
#if RENDER_TIER>=2
// 像素在水面上的两条射线微分包含距离和掠射拉伸；按每个波向过滤，而非只用距离选级。
// 被滤掉的斜率能量转入方差，远处仍有粗糙反射，却不会留下欠采样的波纹。
vec3 waveNormal(vec2 p,vec3 view,float distance,out float roughness){
 float pixel=uSpan/uViewport.y,scale=uOrtho?1.0:distance/rayLength;
 vec2 dx=scale*pixel*(uRight-view*uRight.y/view.y).xz,dy=scale*pixel*(uUp-view*uUp.y/view.y).xz;
 vec2 slope=vec2(0);float variance=.0003;
 for(int i=0;i<16;i++){
  float fi=float(i),angle=fi*2.399963+.37,frequency=.11*pow(1.43,fi),amplitude=.065*pow(.94,fi);
  vec2 d=normalize(vec2(cos(angle),sin(angle)*.8)),k=d*frequency;
  float footprint=dot(k,dx)*dot(k,dx)+dot(k,dy)*dot(k,dy),resolved=exp(-.125*footprint);
  float phase=dot(k,p)-sqrt(9.81*frequency)*uTime+fi*fi*1.7;
  slope+=d*(amplitude*resolved*cos(phase));
  variance+=.5*amplitude*amplitude*(1.0-resolved*resolved);
 }
 roughness=sqrt(variance);
 return normalize(vec3(-slope.x,1,-slope.y));
}
// 可见 GGX 微面采样把样本集中到朝向相机的微面，掠射时不用丢弃大量背面样本。
// 斜率均方根作为分布宽度；Smith 遮蔽在反射合成时补上，避免地平线积出亮边。
vec3 waterMicroNormal(vec3 n,vec3 view,float roughness){
 vec3 t=normalize(cross(vec3(0,0,1),n)),b=cross(n,t);
 vec3 v=normalize(vec3(dot(-view,t)*roughness,dot(-view,b)*roughness,max(dot(-view,n),.0001)));
 float lensq=dot(v.xy,v.xy);
 vec3 t1=lensq>0.0?vec3(-v.y,v.x,0)/sqrt(lensq):vec3(1,0,0),t2=cross(v,t1);
 float r=sqrt(random()),phi=6.2831853*random(),x=r*cos(phi),y=r*sin(phi),s=.5*(1.0+v.z);
 y=mix(sqrt(max(0.0,1.0-x*x)),y,s);
 vec3 h=x*t1+y*t2+sqrt(max(0.0,1.0-x*x-y*y))*v;
 h=normalize(vec3(roughness*h.xy,max(0.0,h.z)));
 return t*h.x+b*h.y+n*h.z;
}
// 可见微面采样已抵消入射遮蔽，只需保留反射方向的 Smith 可见度。
float waterMask(float cosine,float roughness){
 float c=max(cosine,0.0);
 return 2.0*c/(c+sqrt(roughness*roughness+(1.0-roughness*roughness)*c*c));
}
#endif
// 菲涅耳反射率（Schlick 近似）；水的正入射反射率约 2%，掠射时接近全反射。
float fresnel(float cosine,float f0){return f0+(1.0-f0)*pow(1.0-clamp(cosine,0.0,1.0),5.0);}
// 材质的菲涅耳；F0 为零表示材质包没有给出反射率，此时完全不反射。
// 粗糙表面的微面朝向各异，掠射时也不会接近全反射，上限随粗糙度降低。
vec3 fresnel3(float cosine,vec3 f0,float roughness){
 if(brightest(f0)<=0.0)return vec3(0);
 return f0+(max(vec3(1.0-roughness),f0)-f0)*pow(1.0-clamp(cosine,0.0,1.0),5.0);
}
// 每像素一次：光源取太阳或月亮，颜色随高度变化；环境光取天顶与地平线天空的平均，略微去色以免阴影过蓝。
void setupLight(){
 bool sunUp=uSun.y>=0.0;
 lightDir=sunUp?uSun:-uSun;
 float h=lightDir.y;
 lightColor=sunUp
  ?mix(vec3(1.0,.5,.22)*.9,vec3(1.0,.95,.88)*1.1,smoothstep(0.0,.45,h))*smoothstep(0.0,.08,h)
  :vec3(.10,.12,.18)*smoothstep(0.0,.15,h);
 vec3 sky=.5*(skyRadiance(vec3(0,1,0))+skyRadiance(normalize(vec3(0,.15,1))));
 ambient=mix(sky,vec3(dot(sky,vec3(.2126,.7152,.0722))),.35)*1.3+vec3(.004,.005,.008);
}
// 水每格的消光：红光衰减最快，深水因此偏蓝绿。散射比例决定水体自身透出的颜色。
const vec3 WATER_EXTINCTION=vec3(.28,.075,.05),WATER_SCATTER=vec3(.03,.22,.30);
// 把射线在水里走过的一段计入：透过率按距离指数衰减，损失的部分换成水体散射的光。
// 低档的水不吸收，只在界面上像玻璃一样透过。
void absorbWater(float t){
#if RENDER_TIER>=2
 if(waterFrom<0.0||t<=waterFrom)return;
 vec3 kept=exp(-WATER_EXTINCTION*(t-waterFrom));
 radiance+=throughput*(1.0-kept)*WATER_SCATTER*(ambient+lightColor*max(lightDir.y,0.0)*.5);
 throughput*=kept;waterFrom=t;
#endif
}
// 按轴取分量时不用 v[axis]：ANGLE 在 D3D 上会把动态下标翻译成可索引临时数组，很慢。
float pick(vec3 v,int axis){return axis==0?v.x:axis==1?v.y:v.z;}
vec2 across(vec3 v,int axis){return axis==0?v.yz:axis==1?v.zx:v.xy;}
// across 的逆：面内两个分量放回三维。
vec3 fromAcross(vec2 v,int axis){return axis==0?vec3(0,v):axis==1?vec3(v.y,0,v.x):vec3(v,0);}
vec3 axisNormal(int side){vec3 n=vec3(equal(ivec3(side/2),ivec3(0,1,2)));return side%2==0?-n:n;}
uvec4 model(uint id){return texelFetch(uModels,ivec2(int(id)%2048,int(id)/2048),0);}
vec4 table(sampler2D source,int offset){return texelFetch(source,ivec2(offset%2048,offset/2048),0);}
uint worldWord(uint offset){return texelFetch(uWorldData,ivec2(int(offset)%4096,int(offset)/4096),0).r;}
// 一次命中的表面材质。geometric 是朝向射线来处的几何法线，normal 是法线贴图扰动后的着色法线；
// f0 为正入射反射率（金属为自身颜色），diffuse 为 0 表示金属没有漫反射；emission 是自发光强度。
struct Material{vec3 geometric,normal,f0;float occlusion,roughness,emission,diffuse;};
Material plainMaterial(vec3 normal){return Material(normal,normal,vec3(0),1.0,1.0,0.0,1.0);}
// labPBR 的数据贴图：法线 RG 为 DirectX 方向（X 向右、Y 向贴图下方），B 为环境光遮蔽；
// 高光 R 为光滑度，G 的 0–229 是线性 F0、230 以上是金属，A 的 0–254 是自发光、255 表示不发光。
// tangentS、tangentT 是贴图横向与纵向在世界里的方向。
Material decodeMaterial(vec3 geometric,vec3 tangentS,vec3 tangentT,vec4 normalTexel,vec4 specularTexel,vec3 albedo){
 vec2 xy=normalTexel.xy*2.0-1.0;
 vec3 normal=normalize(tangentS*xy.x+tangentT*xy.y+geometric*sqrt(max(0.0,1.0-dot(xy,xy))));
 float reflectance=specularTexel.g*255.0,glow=specularTexel.a*255.0;
 bool metal=reflectance>229.5;
 return Material(geometric,normal,metal?albedo:vec3(reflectance/255.0),normalTexel.b,
  (1.0-specularTexel.r)*(1.0-specularTexel.r),glow<254.5?glow/254.0:0.0,metal?0.0:1.0);
}
// 低档不读法线与反射率，只保留自发光，夜间灯块仍然亮着。
Material glowMaterial(vec3 normal,vec4 specularTexel){
 Material m=plainMaterial(normal);
 float glow=specularTexel.a*255.0;
 m.emission=glow<254.5?glow/254.0:0.0;
 return m;
}
// 自发光以线性颜色乘强度；满值为 1.6，配合夜间曝光仍保留灯块纹路。
const float EMISSION=1.6;
// 光源方向上的镜面高光（GGX 分布、Smith 遮蔽、Schlick 菲涅耳），已乘 N·L。F0 为零的表面没有镜面项。
vec3 specularLight(Material m,vec3 view,vec3 light){
 if(brightest(m.f0)<=0.0)return vec3(0);
 vec3 h=normalize(light-view);
 float nl=max(dot(m.normal,light),0.0),nv=max(dot(m.normal,-view),1e-3),nh=max(dot(m.normal,h),0.0);
 float a=max(m.roughness,.05),a2=a*a,k=a*.5;
 float d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));
 float g=nl/(nl*(1.0-k)+k)*nv/(nv*(1.0-k)+k);
 vec3 f=m.f0+(1.0-m.f0)*pow(1.0-max(dot(h,-view),0.0),5.0);
 return d*g*f/(4.0*nv)*m.occlusion;
}
// 模型头的 w 是介质组，同组的玻璃或水之间不画接缝；调用方传入已读取的模型头，避免重复查表。
bool sameMedium(uint a,uint groupA,uint b,uint groupB){return a==b||(a!=0u&&b!=0u&&groupA!=0u&&groupA==groupB);}
void contribute(vec3 rgb,float alpha,float t,Material m,bool unlit){
 if(alpha<=0.0)return;
 absorbWater(t);
 if(!touched){touched=true;firstDepth=t+primaryTravel;firstNormal=m.geometric;}
 if(uPicking){throughput=vec3(0);return;}
 vec3 weight=throughput*(alpha*foliage);
 if(unlit){radiance+=weight*rgb;throughput*=1.0-alpha;return;}
 // 环境光直接计入；光源直射单独累计，最后乘阴影射线的可见度。几何上背光的面不受直射，法线贴图不能让它发亮。
 vec3 diffuse=weight*rgb*m.diffuse*m.occlusion;
 float lit=dot(m.geometric,lightDir)>0.0?1.0:0.0;
 float direct=max(dot(m.normal,lightDir),0.0)*lit;
 vec3 specular=weight*fresnel3(dot(m.normal,-ray),m.f0,m.roughness)*m.occlusion;
 // 常量环境光按朝向打折：朝上的面看到整片天空，侧面和朝下的面有一半以上被地面与周围遮住。
 // 累积反弹会把它换成实际看到的亮度，这里只让预览的明暗接近收敛后的画面。
 vec3 sky=diffuse*ambient*(.7+.3*m.normal.y);
 radiance+=sky+weight*rgb*m.emission*EMISSION;
 directSum+=(diffuse*direct+weight*specularLight(m,ray,lightDir)*lit)*lightColor;
 float w=brightest(weight);
 if(lit>0.0&&w>shadeWeight){shadeWeight=w;shadePoint=eye+ray*t;shadeNormal=m.geometric;}
 if(w>bounceWeight){
  bounceWeight=w;bouncePoint=eye+ray*t;bounceNormal=m.geometric;bounceAlbedo=diffuse;bounceAmbient=sky;
  bounceSpecular=specular;bounceShading=m.normal;bounceView=ray;bounceRoughness=m.roughness;
 }
 throughput*=1.0-alpha;
}
// 方块面贴图：每级 mip 内取最近纹素，保持与游戏一致的像素硬边，级间线性混合避免闪烁。
// 斜看时沿足迹长轴取至多 4 个点平均，代替硬件各向异性过滤（后者在 D3D 上总带双线性模糊）。
// lod 返回所用的 mip 级，法线与高光贴图按同一级取样。
vec4 surfaceTexel(vec2 tile,float layer,vec2 gx,vec2 gy,out float lod){
 bool alongX=dot(gx,gx)>=dot(gy,gy);
 vec2 major=alongX?gx:gy,minor=alongX?gy:gx;
 float side=float(textureSize(uSurfaces,0).x);
 float majorTexels=length(major)*side,minorTexels=length(minor)*side;
 int taps=int(clamp(ceil(majorTexels/max(minorTexels,1e-6)),1.0,4.0));
 lod=log2(max(max(minorTexels,majorTexels/float(taps)),1e-6));
 vec4 sum=vec4(0);
 for(int i=0;i<4;i++){
  if(i>=taps)break;
  sum+=textureLod(uSurfaces,vec3(tile+major*((float(i)+.5)/float(taps)-.5),layer),lod);
 }
 return sum/float(taps);
}
// 完整方块只需面方向与命中位置，不访问模型表面。透明度仍只在介质边界累计。
// 面表每面 4 项：贴图空间原点与 u 方向、v 方向与层号（负数为纯色）与标志、线性色调与不透明度系数、代表色。
// cutout 为真时按 alpha 裁切：透明处不留下任何颜色，射线继续前进。
bool cubeSurface(uint fastOffset,int side,float t,bool cutout){
 int offset=int(fastOffset)+side*4;
 vec4 f0=table(uFast,offset),f1=table(uFast,offset+1),f2=table(uFast,offset+2);
 vec3 normal=axisNormal(side);
 if(dot(normal,ray)>0.0)normal=-normal;
 if(f1.z<0.0){vec4 color=table(uFast,offset+3);contribute(linearColor(color.rgb),color.a,t,plainMaterial(normal),false);return true;}
 int axis=side/2;
 vec2 uv=across(fract(eye+ray*t),axis);
 vec2 tile=f0.xy+f0.zw*uv.x+f1.xy*uv.y;
 // 射线微分：相邻像素的射线在这个面上相距多远，决定 mip 级与长轴方向。
 vec4 texel;float lod;
 if(primaryRay){
  float pixel=uSpan/uViewport.y,scale=uOrtho?1.0:(t+primaryTravel)/rayLength,facing=pick(ray,axis);
  vec3 dx=scale*pixel*(uRight-ray*pick(uRight,axis)/facing),dy=scale*pixel*(uUp-ray*pick(uUp,axis)/facing);
  vec2 sx=across(dx,axis),sy=across(dy,axis);
  texel=surfaceTexel(tile,f1.z,f0.zw*sx.x+f1.xy*sx.y,f0.zw*sy.x+f1.xy*sy.y,lod);
 }else{
  // 次级射线没有像素足迹，按距离粗略选级：原版 16 像素的贴图在 4 格外开始缩小。
  float side=float(textureSize(uSurfaces,0).x);
  lod=clamp(log2(t*.25*side/16.0),0.0,log2(side));
  texel=textureLod(uSurfaces,vec3(tile,f1.z),lod);
 }
 if(cutout&&texel.a<0.5)return false;
 vec3 color=texel.rgb/max(texel.a,1e-4)*f2.rgb;
 float alpha=cutout?1.0:mod(f1.w,2.0)==1.0?texel.a*f2.w:table(uFast,offset+3).a;
#if RENDER_TIER>=2
 // 贴图坐标对面内坐标的导数是 [f0.zw f1.xy]，取逆得到贴图横纵两个方向在面内的走向。
 float det=f0.z*f1.y-f1.x*f0.w;
 vec3 tangentS=normalize(fromAcross(vec2(f1.y,-f0.w)/det,axis)),tangentT=normalize(fromAcross(vec2(-f1.x,f0.z)/det,axis));
 Material m=decodeMaterial(normal,tangentS,tangentT,
  textureLod(uSurfaceNormals,vec3(tile,f1.z),lod),textureLod(uSurfaceSpecular,vec3(tile,f1.z),lod),color);
#else
 Material m=glowMaterial(normal,textureLod(uSurfaceSpecular,vec3(tile,f1.z),lod));
#endif
 contribute(color,alpha,t,m,f1.w>=2.0);
 return true;
}
// 介质边界上的面：体素档画模型代表色的纯色面，其余各档按完整方块面表着色。
void boundarySurface(uint id,uvec4 description,int side,float t){
#if RENDER_TIER==0
 // 完整方块每面用资源包的代表色（已含色调；草方块顶面绿、侧面土色），复杂模型整体用平均色。
 int at=int(id)*2;
 vec4 color=table(uVoxels,at);
 if(description.x==1u||description.x==3u){
  int face=int(description.y)+side*4;
  color=vec4(linearColor(table(uFast,face+3).rgb),color.a);
 }
 vec3 normal=axisNormal(side);
 if(dot(normal,ray)>0.0)normal=-normal;
 Material m=plainMaterial(normal);m.emission=table(uVoxels,at+1).x;
 contribute(color.rgb,color.a,t,m,false);
#else
 cubeSurface(description.y,side,t,false);
#endif
}
struct Hit{float t;vec3 color;float alpha;Material material;bool unlit;};
#include <objects>
vec3 octahedralNormal(uint packed){
 vec2 e=unpackSnorm2x16(packed);vec3 n=vec3(e,1.0-abs(e.x)-abs(e.y));float t=max(-n.z,0.0);
 n.xy-=t*vec2(n.x>=0.0?1.0:-1.0,n.y>=0.0?1.0:-1.0);return normalize(n);
}
// 每个面先只读一条引用求平面交点；交点不在本格射线区间内的面无需读取记录。
// alpha 裁切失败的面不阻挡后方更远的命中。
void intersectModel(uint id,ivec3 cell,float begin,float end,inout Hit hit){
 if((id&0x80000000u)!=0u){intersectObject(id&0x7fffffffu,begin,end,hit);return;}
 uvec4 description=model(id);if(description.x!=2u)return;
 vec3 origin=eye-vec3(cell);
 for(uint i=0u;i<description.z;i++){
  faceTests++;
  int index=int(description.y+i);
  uvec4 reference=texelFetch(uQuadReferences,ivec2(index%2048,index/2048),0);
  vec3 normal=octahedralNormal(reference.x);float facing=dot(normal,ray);
  if(abs(facing)<1e-8||(reference.w==0u&&facing>=0.0))continue;
  float t=(uintBitsToFloat(reference.y)-dot(normal,origin))/facing;
  if(t<begin||t>end+EPS||t>=hit.t)continue;
  int offset=int(reference.z)*7;
  vec3 p=origin+ray*t;
  vec4 U=table(uQuadRecords,offset),V=table(uQuadRecords,offset+1);
  float u=dot(U.xyz,p)+U.w,v=dot(V.xyz,p)+V.w;
  if(u<0.0||u>1.0||v<0.0||v>1.0)continue;
  vec4 a=table(uQuadRecords,offset+2),b=table(uQuadRecords,offset+3),region=table(uQuadRecords,offset+4),tint=table(uQuadRecords,offset+5);
  vec2 uv=a.xy+u*a.zw+v*b.xy;
  vec2 atlasSize=vec2(textureSize(uAtlas,0));
  ivec2 pixel=ivec2((region.xy+clamp(uv,vec2(0),vec2(.999999))*region.zw)*atlasSize);
  vec4 texel=texelFetch(uAtlas,pixel,0);float alpha=texel.a*tint.w;
  if(int(b.z)==1&&alpha<.1)continue;
  if(int(b.z)!=2)alpha=1.0;
  if(alpha<=0.0)continue;
  vec3 geometric=table(uQuadRecords,offset+6).xyz;
  if(dot(geometric,ray)>0.0)geometric=-geometric;
  hit.t=t;hit.color=linearColor(texel.rgb)*tint.rgb;hit.alpha=alpha;hit.unlit=b.w>=2.0;
#if RENDER_TIER>=2
  // 平面上沿参数 u、v 前进的方向（与 U、V 互为对偶），再按贴图坐标对 (u,v) 的导数 [a.zw b.xy] 取逆，得到贴图横纵方向。
  vec3 alongU=cross(V.xyz,normal)/dot(U.xyz,cross(V.xyz,normal)),alongV=cross(normal,U.xyz)/dot(V.xyz,cross(normal,U.xyz));
  float det=a.z*b.y-b.x*a.w;
  vec3 tangentS=normalize((alongU*b.y-alongV*a.w)/det),tangentT=normalize((alongV*a.z-alongU*b.x)/det);
  hit.material=decodeMaterial(geometric,tangentS,tangentT,texelFetch(uAtlasNormals,pixel,0),texelFetch(uAtlasSpecular,pixel,0),hit.color);
#else
  hit.material=glowMaterial(geometric,texelFetch(uAtlasSpecular,pixel,0));
#endif
 }
}
// 求射线离开轴对齐节点的时间；落在边界上的轴按整数跳到下一格，避免掠射时反复停在同一格。
float leaveNode(ivec3 lowerCell,int width,out int side,out ivec3 nextCell){
 vec3 lower=max(vec3(lowerCell),vec3(0)),upper=min(vec3(lowerCell+width),uSize);
 vec3 distance=(mix(lower,upper,greaterThan(ray,vec3(0)))-eye)*invRay;
 distance=mix(distance,vec3(1e30),lessThan(abs(ray),vec3(1e-8)));
 int axis=distance.x<=distance.y&&distance.x<=distance.z?0:distance.y<=distance.z?1:2;
 float next=min(distance.x,min(distance.y,distance.z));
 side=axis*2+(pick(ray,axis)>0.0?1:0);
 ivec3 lo=ivec3(lower),hi=ivec3(upper);
 ivec3 inside=clamp(ivec3(floor(eye+ray*next)),lo,hi-1);
 ivec3 stepped=ivec3(ray.x>0.0?hi.x:lo.x-1,ray.y>0.0?hi.y:lo.y-1,ray.z>0.0?hi.z:lo.z-1);
 bvec3 crossing=equal(distance,vec3(next));
 nextCell=ivec3(crossing.x?stepped.x:inside.x,crossing.y?stepped.y:inside.y,crossing.z?stepped.z:inside.z);
 return next;
}
uint localIndex(ivec3 p){return uint((p.x*16+p.z)*16+p.y);}
bool maskBit(uvec2 mask,int bit){return (((bit<32?mask.x:mask.y)>>uint(bit&31))&1u)!=0u;}
// 射线状态：缓存当前 section 的目录项与当前小块的格子掩码，同一 section 内移动不再读目录。
ivec3 cachedSection;
uvec4 section;
uint partsBase;
int cachedBrick;
uvec2 cellMask;
uint brickTag;
// 找出包含 cell 的最大均匀节点；返回节点内容，level 为节点边长的 log2。
// 有方块的格子返回 cellLevel=true，并给出片段列表地址。
// 保留统一返回：多个提前返回与 out 参数的组合会触发 D3D 编译校验错误及重试。
uint locate(ivec3 cell,out int level,out bool cellLevel,out uint parts){
 level=0;cellLevel=false;parts=0u;
 ivec3 directory=(cell+uDirectoryOffset)>>4;
 if(cell>>4!=cachedSection){
  cachedSection=cell>>4;cachedBrick=-1;
  section=texelFetch(uSections,directory&ivec3(255,31,255),0);
  partsBase=section.x!=0u&&uFragments?worldWord(section.x+AUX_PARTS):0u;
 }
 uint result=0u;
 if(section.x==0u){
  result=section.y;
  if(uHierarchy){
   // 均匀 section 向上查目录层次，直到父节点不再均匀。
   level=4;
   for(int l=1;l<=8;l++){if(texelFetch(uTree,(directory&ivec3(255,31,255))>>l,l).r!=section.y)break;level=l+4;}
  }
 }else{
  ivec3 local=cell&15;
  int brick=((local.x>>2)*4+(local.z>>2))*4+(local.y>>2);
  if(maskBit(section.zw,brick)){
   if(brick!=cachedBrick){
    cachedBrick=brick;
    uint at=section.x+uint(brick*2);
    cellMask=uvec2(worldWord(at),worldWord(at+1u));
    brickTag=worldWord(section.x+AUX_TAGS+uint(brick));
   }
   if(brickTag!=MIXED){level=uHierarchy?2:0;result=brickTag;}
   else if(maskBit(cellMask,((local.x&3)*4+(local.z&3))*4+(local.y&3))){
    cellLevel=true;
    uint index=localIndex(local),bits=section.y>>27,palette=0u;
    if(bits!=0u){uint per=32u/bits;palette=(worldWord((section.y&0x7ffffffu)+index/per)>>((index%per)*bits))&((1u<<bits)-1u);}
    if(partsBase!=0u)parts=worldWord(partsBase+index);
    result=worldWord(section.x+AUX_PALETTE+palette);
   }
  }else{level=uHierarchy?2:0;}
 }
 return result;
}
#if RENDER_TIER>=2
// 阴影射线：从命中点走向光源，只关心沿途透过了多少光，不着色。
// 不透明立方体与镂空面的实心处完全遮挡；玻璃按代表色过滤，染色玻璃因此投下彩色影子；水按走过的距离吸收。
// 射线离开观察窗口即视为照到光源，窗口外的地形不投影。
float alphaAt(uint fastOffset,int side,float t){
 int offset=int(fastOffset)+side*4;
 vec4 f0=table(uFast,offset),f1=table(uFast,offset+1);
 vec2 uv=across(fract(eye+ray*t),side/2);
 return textureLod(uSurfaces,vec3(f0.xy+f0.zw*uv.x+f1.xy*uv.y,f1.z),0.0).a;
}
vec3 sunVisibility(vec3 origin,vec3 direction){
 eye=origin;ray=direction;invRay=vec3(1)/ray;
 cachedSection=ivec3(-1);cachedBrick=-1;
 vec3 far=(mix(vec3(0),uSize,greaterThan(ray,vec3(0)))-eye)*invRay;
 far=mix(far,vec3(1e30),lessThan(abs(ray),vec3(1e-8)));
 float last=min(far.x,min(far.y,far.z)),t=0.0,waterStart=0.0;
 vec3 light=vec3(1);
 ivec3 cell=ivec3(floor(eye));int side=0;uint previous=0u;bool inWater=false;
 for(int iteration=0;iteration<1024;iteration++){
  if(t>=last-EPS||any(lessThan(cell,ivec3(0)))||any(greaterThanEqual(cell,ivec3(uSize))))break;
  int level;bool cellLevel;uint parts;
  uint current=locate(cell,level,cellLevel,parts);
  int width=1<<level;
  ivec3 lower=((cell+uDirectoryOffset)&ivec3(~(width-1)))-uDirectoryOffset;
  int exitSide;ivec3 nextCell;float end=min(last,leaveNode(lower,width,exitSide,nextCell));
  uvec4 description=current==0u?uvec4(0):model(current);
  bool water=description.x==1u&&description.w==uWaterGroup;
  if(inWater&&!water){light*=exp(-WATER_EXTINCTION*(t-waterStart));inWater=false;}
  if(water&&!inWater){inWater=true;waterStart=t;}
  if(current!=0u){
   if(description.x==1u&&current!=previous&&!water){
    int face=int(description.y)+side*4;
    if(mod(table(uFast,face+1).w,2.0)!=1.0)return vec3(0);
    vec4 tint=table(uFast,face+3);
    light*=mix(vec3(1),linearColor(tint.rgb),tint.a);
   }
   if(description.x==3u&&t>0.0&&alphaAt(description.y,side,t)>=0.5)return vec3(0);
   if(cellLevel){
    Hit hit;hit.t=end+1.0;hit.alpha=0.0;
    intersectModel(current,cell,max(t,1e-3),end,hit);
    if(parts!=0u){
     uint count=worldWord(parts);
     for(uint j=0u;j<count;j++)intersectModel(worldWord(parts+1u+j),cell,max(t,1e-3),end,hit);
    }
    if(hit.alpha>=.99)return vec3(0);
    light*=mix(vec3(1),hit.color,hit.alpha);
   }
   if(brightest(light)<0.02)return vec3(0);
  }
  previous=current;t=end;cell=nextCell;side=exitSide^1;
 }
 return light;
}
#endif
// 平行于窗口边界的射线单独处理，避免 0×无穷产生 NaN。
void windowInterval(out vec3 entry,out vec3 leave){
 bvec3 parallel=lessThan(abs(ray),vec3(1e-8));
 vec3 nearSide=(vec3(0)-eye)*invRay,farSide=(uSize-eye)*invRay;
 entry=min(nearSide,farSide);leave=max(nearSide,farSide);
 bvec3 within=bvec3(vec3(greaterThanEqual(eye,vec3(0)))*vec3(lessThan(eye,uSize)));
 entry=mix(entry,mix(vec3(1e30),vec3(-1e30),within),parallel);
 leave=mix(leave,vec3(1e30),parallel);
}
// 沿当前射线走完窗口；高空起点先靠近入口，避免大距离浮点误差使格子边界漏面。
// limit 让主射线停在解析水面；submerged 让窗口内外的路程都按海水吸收。
// 主射线保留靠近前的距离，拾取、雾与透视纹理足迹仍相对原来的像平面。
bool march(float limit,bool submerged){
 float traveled=0.0;
 invRay=vec3(1)/ray;
 vec3 entry,leave;windowInterval(entry,leave);
 float first=max(entry.x,max(entry.y,entry.z)),last=min(limit,min(leave.x,min(leave.y,leave.z)));
 if(first>1.0&&first<last){
  float travel=first-1.0;eye+=ray*travel;traveled=travel;limit-=travel;
  if(primaryRay)primaryTravel+=travel;
  windowInterval(entry,leave);
  first=max(entry.x,max(entry.y,entry.z));last=min(limit,min(leave.x,min(leave.y,leave.z)));
 }
 float t=max(.01,first);int axis=entry.x>=entry.y&&entry.x>=entry.z?0:entry.y>=entry.z?1:2;
 int side=axis*2+(pick(ray,axis)<0.0?1:0);
 radiance=vec3(0);directSum=vec3(0);throughput=vec3(1);shadeWeight=0.0;bounceWeight=0.0;
 foliage=1.0;touched=false;firstDepth=0.0;waterFrom=submerged?0.0:-1.0;mirrored=false;
 cachedSection=ivec3(-1);cachedBrick=-1;
 if(submerged){waterFrom=0.0;absorbWater(traveled);waterFrom=0.0;}
 if(!uHasWorld){if(submerged)absorbWater(limit);return true;}
 float afterHit=.01;uint previous=0u;uvec4 previousModel=uvec4(0);bool entering=true,inside=first<.01;bool finished=t>=last;
 ivec3 cell=clamp(ivec3(floor(eye+ray*(t+EPS))),ivec3(0),ivec3(uSize)-1);
 for(int iteration=0;iteration<2048;iteration++){
  if(finished)break;
  steps++;
  if(any(lessThan(cell,ivec3(0)))||any(greaterThanEqual(cell,ivec3(uSize)))){finished=true;break;}
  int level;bool cellLevel;uint parts;
  uint current=locate(cell,level,cellLevel,parts);
  // 跨过整块空域说明已经离开树冠。
  if(current==0u&&level>=2)foliage=1.0;
  int width=1<<level;
  ivec3 lower=((cell+uDirectoryOffset)&ivec3(~(width-1)))-uDirectoryOffset;
  uvec4 description=current==0u?uvec4(0):model(current);
#if RENDER_TIER==0
  // 体素档把每个非空格子都当作完整立方体的介质，不再区分模型形状。
  bool cutout=false;uint cutoutFaces=0u,medium=current;
#else
  // 镂空立方体（树叶、格栅）对介质规则而言等同空气，只在进入时测本格的入射面，相邻同类之间的面也可见。
  bool cutout=description.x==3u;uint cutoutFaces=description.y;
  uint medium=description.x==1u?current:0u;
#endif
  if(medium==0u)description=uvec4(0);
  int exitSide;ivec3 nextCell;float end=min(last,leaveNode(lower,width,exitSide,nextCell));
  if(entering){
   // 水只在进出两个界面着色，界面之间按走过的距离吸收。
   bool water=medium!=0u&&description.w==uWaterGroup;
   if(!inside&&!sameMedium(previous,previousModel.w,medium,description.w)){
    if(previous!=0u){absorbWater(t);boundarySurface(previous,previousModel,side^1,t);}
    if(!water&&!submerged)waterFrom=-1.0;
#if RENDER_TIER>=2
    if(water&&primaryRay&&!mirrored&&side==3){mirrored=true;mirrorPoint=eye+ray*t;mirrorWeight=throughput;mirrorRadiance=radiance;mirrorDirect=directSum;}
#endif
    if(brightest(throughput)>0.001&&medium!=0u)boundarySurface(medium,description,side,t);
   }
   if(water&&waterFrom<0.0)waterFrom=t;
   bool gap=cutout&&!inside&&brightest(throughput)>0.001&&!cubeSurface(cutoutFaces,side,t,true);
#if RENDER_TIER>=2
   if(gap)foliage*=0.6;
#endif
   inside=false;previous=medium;previousModel=description;entering=false;
  }
  if(brightest(throughput)<=.001){finished=true;break;}
  Hit hit;hit.t=end+1.0;hit.alpha=0.0;
#if RENDER_TIER>0
  if(cellLevel){
   intersectModel(current,cell,max(t,afterHit),end,hit);
   if(parts!=0u){
    uint count=worldWord(parts);
    for(uint j=0u;j<count;j++)intersectModel(worldWord(parts+1u+j),cell,max(t,afterHit),end,hit);
   }
  }
#endif
  if(hit.alpha>0.0){contribute(hit.color,hit.alpha,hit.t,hit.material,hit.unlit);if(brightest(throughput)<=.001){finished=true;break;}afterHit=hit.t+EPS;t=afterHit;if(t<end-EPS)continue;}
  t=end;cell=nextCell;side=exitSide^1;entering=true;
  if(t>=last-EPS){absorbWater(t);if(last<limit&&previous!=0u&&brightest(throughput)>.001)boundarySurface(previous,previousModel,exitSide,t);finished=true;break;}
 }
 if(submerged&&brightest(throughput)>.001)absorbWater(limit);
 return finished;
}
// 星点固定在方向球的立体投影网格里；解析像素滤波保持点的能量，转动相机不会随机闪灭。
// 星心留在格内，邻域合成覆盖跨格的像素足迹；只绘制地平线以上的夜空。
vec3 stars(vec3 d){
 float night=1.0-smoothstep(-.18,.02,uSun.y);
 if(night<=0.0||d.y<=0.0)return vec3(0);
 vec2 p=d.xz/(1.0+d.y)*240.0,cell=floor(p);
 float footprint=uOrtho?.28:240.0*uSpan/uViewport.y/(1.0+d.y);
 float width=sqrt(.035*.035+.25*footprint*footprint);
 vec3 light=vec3(0);
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  ivec2 c=ivec2(cell)+ivec2(x,y);
  uint h=pcg(uint(c.x)*1973u+uint(c.y)*9277u);
  float chance=float(h&65535u)/65535.0;
  if(chance>.012)continue;
  vec2 center=vec2(c)+.2+.6*vec2(float(pcg(h)&65535u),float(pcg(h+1u)&65535u))/65535.0;
  vec2 delta=p-center;
  float intensity=.0015/(width*width)*exp(-.5*dot(delta,delta)/(width*width));
  light+=mix(vec3(.55,.7,1),vec3(1,.83,.6),float(pcg(h+2u)&255u)/255.0)*intensity*(.4+chance*120.0);
 }
 return light*night*smoothstep(0.0,.12,d.y);
}
// 背景天空；主射线与水面反射还能看到太阳与月亮的圆盘，漫反射反弹里的阳光已由直射项计入。
vec3 background(vec3 d){
 vec3 sky=skyRadiance(d)+stars(d);
 float toward=dot(d,uSun);
 sky+=vec3(1.0,.9,.75)*30.0*smoothstep(.9996,.9997,toward)*smoothstep(-.05,.02,uSun.y);
 sky+=vec3(.8,.85,1.0)*2.0*smoothstep(.9997,.9998,-toward)*smoothstep(-.02,.05,-uSun.y);
 return sky;
}
#if RENDER_TIER>=2
// 刚走完的射线所受的直射光：乘一条阴影射线的可见度。soft 为真时在太阳圆盘范围内抖动方向，得到柔和的影子边缘。
// 阴影射线会改写 eye 与 ray。
vec3 directLight(bool soft){
 if(shadeWeight<=0.0)return directSum;
 return directSum*sunVisibility(shadePoint+shadeNormal*1e-3,soft?coneDirection(lightDir,.012):lightDir);
}
// 海面只分出一条反射和一条折射，二者都复用体素求交；预览不为它们另发阴影射线。
// 水下到窗口入口的路程也吸收，未命中的折射射线最终只剩深水散射。
vec3 oceanRadiance(vec3 point,vec3 view,float distance){
 float roughness;vec3 n=waveNormal((point+uWorldOrigin).xz,view,distance,roughness);
 vec3 micro=uPass==1?waterMicroNormal(n,view,roughness):n;
 float f=fresnel(dot(-view,micro),.02);
 vec3 reflected=vec3(0),r=reflect(view,micro);
 // 预览把朝入几何平面的方向折回；单条平均法线不能表达波峰遮蔽，折回可避免黑色裂缝。
 if(uPass==0)r.y=abs(r.y);
 if(r.y>0.0){
  eye=point+vec3(0,.001,0);ray=r;primaryRay=false;
  march(1e30,false);
  reflected=radiance+(brightest(throughput)>.001?throughput*background(r):vec3(0))+(uPass==1?directLight(true):directSum);
  if(uPass==1)reflected*=waterMask(dot(n,r),roughness);
 }
 // 折射取已过滤的平均法线，避免单样本透射把水下几何打碎。
 vec3 refracted=refract(view,n,1.0/1.333);
 eye=point-vec3(0,.001,0);ray=refracted;primaryRay=false;
 march(1e4,true);
 vec3 transmitted=radiance+(uPass==1?directLight(true):directSum);
 return f*reflected+(1.0-f)*transmitted;
}
// 水下视点用平面界面折射出水；超出临界角时全反射，避免把水面上方的世界截掉。
vec3 oceanExitRadiance(vec3 point,vec3 view){
 vec3 outgoing=refract(view,vec3(0,-1,0),1.333);
 bool internal=dot(outgoing,outgoing)<.001;
 if(internal)outgoing=reflect(view,vec3(0,1,0));
 eye=point+vec3(0,internal?-.001:.001,0);ray=outgoing;primaryRay=false;
 march(internal?1e4:1e30,internal);
 return radiance+throughput*background(outgoing)+(uPass==1?directLight(true):directSum);
}
#endif
// 一个像素的线性亮度。主射线之后最多再分出三类射线：阴影、水面反射、累积时的反弹。
// 反弹用看到的亮度替换代表表面的常量环境光，墙角、屋檐下因此自然变暗，亮面也会映到旁边；
// 有反射率的材质还会按菲涅耳的比例沿镜面方向反弹，光滑的表面因此映出周围。
// 多次反弹时，每一跳的表面再把自己的常量环境光换成下一跳看到的亮度。
vec3 tracePixel(vec2 pixel){
 vec2 screen=(pixel/uViewport-.5)*vec2(uViewport.x/uViewport.y,1)*uSpan;
 vec3 offset=screen.x*uRight+screen.y*uUp;
 vec3 direction=uOrtho?uForward:uForward+offset;
 rayLength=length(direction);ray=direction/rayLength;eye=uCamera+(uOrtho?offset:vec3(0));primaryRay=true;primaryTravel=0.0;
 touched=false;firstDepth=-1.0;firstNormal=vec3(0);
 if(!uHasWorld&&!uOcean)return background(ray);
 vec3 view=ray,origin=eye;
 bool underwater=uOcean&&!uPicking&&eye.y<uOceanHeight;
 float oceanDistance=uOcean&&!uPicking&&abs(ray.y)>1e-8?(uOceanHeight-eye.y)/ray.y:-1.0;
 bool oceanHit=oceanDistance>0.0;
 // 迭代用尽时输出极亮的品红，色调映射后仍是纯品红，实验脚本据此统计。
 if(!march(oceanHit?oceanDistance:1e30,underwater))return vec3(1e4,0,1e4);
 if(uPicking)return vec3(0);
#if RENDER_TIER<2
 // 低档没有阴影、雾与水面效果。无限海面只是一层与静止水同色的透明平面，穿过后沿原方向继续；
 // 最终停在海平面以下的射线显示深水的颜色，而不是天空。
 vec4 waterColor=table(uFast,int(model(uWater).y)+3*4+3);
 vec3 waterLinear=linearColor(waterColor.rgb);
 vec3 color=radiance+directSum,remaining=throughput;
 bool deep=underwater;
 if(oceanHit&&brightest(remaining)>.001){
  radiance=vec3(0);directSum=vec3(0);throughput=vec3(1);
  eye=origin+view*oceanDistance;ray=view;primaryRay=false;
  contribute(waterLinear,waterColor.a,0.0,plainMaterial(vec3(0,underwater?-1:1,0)),false);
  vec3 surface=radiance+directSum,through=throughput;
  eye+=vec3(0,underwater?1e-3:-1e-3,0);
  march(1e30,false);
  color+=remaining*(surface+through*(radiance+directSum));
  remaining*=through*throughput;
  deep=!underwater;
 }
 if(brightest(remaining)>.001)
  color+=remaining*(deep?waterLinear*(ambient+lightColor*max(lightDir.y,0.0))*.5:background(view));
 return color;
#else
 bool soft=uPass==1;
 // 八次方让近处几乎没有雾，接近雾距离时才迅速变浓。
 float fog=touched&&!underwater?1.0-exp(-3.0*pow(firstDepth/uFog,8.0)):0.0;
 // 后面的射线会覆盖合成结果与代表表面，先把主射线需要的部分留下。
 vec3 front=radiance,frontDirect=directSum,remaining=throughput;
 vec3 behind=brightest(throughput)>.001?throughput*background(view):vec3(0);
 bool sea=oceanHit&&!underwater&&brightest(remaining)>.001;
 bool water=mirrored,bounce=uPass==1&&bounceWeight>0.0;
 vec3 waterPoint=mirrorPoint,waterWeight=mirrorWeight,above=mirrorRadiance,aboveDirect=mirrorDirect;
 vec3 weight=bounceAlbedo,constant=bounceAmbient,specular=bounceSpecular,point=bouncePoint,normal=bounceNormal,shading=bounceShading,incoming=bounceView;
 float roughness=bounceRoughness;
 vec3 visible=shadeWeight>0.0?sunVisibility(shadePoint+shadeNormal*1e-3,soft?coneDirection(lightDir,.012):lightDir):vec3(1);
 vec3 color=front+frontDirect*visible+behind;
 if(underwater&&oceanHit&&brightest(remaining)>.001){
  color=front+frontDirect*visible+remaining*oceanExitRadiance(origin+view*oceanDistance,view);
 }
 if(sea){
  color=front+frontDirect*visible+remaining*oceanRadiance(origin+view*oceanDistance,view,oceanDistance);
 }
 if(water){
  // 水面以上的部分不变，水面及水下按 1-F 透过，再加上反射看到的 F。
  float waterRoughness;vec3 n=waveNormal((waterPoint+uWorldOrigin).xz,view,length(waterPoint-origin),waterRoughness);
  if(soft)n=waterMicroNormal(n,view,waterRoughness);
  vec3 r=reflect(view,n);r.y=abs(r.y);
  float f=fresnel(dot(-view,n),.02);
  vec3 kept=above+aboveDirect*visible;
  eye=waterPoint+vec3(0,1e-3,0);ray=r;primaryRay=false;
  march(1e30,false);
  vec3 seen=radiance+throughput*background(r)+directLight(soft);
  color=kept+(1.0-f)*(color-kept)+f*waterWeight*seen;
 }
 if(bounce){
  color-=constant;
  for(int b=0;b<4;b++){
   if(b>=uBounces)break;
   // 按漫反射与镜面两部分的大小随机选一个方向，再除以选中的概率，期望仍是两部分之和。
   // 镜面方向在着色法线附近按粗糙度抖动后反射；落到表面以下时翻回来。
   float chance=brightest(specular)/(brightest(specular)+brightest(weight)+1e-6);
   vec3 carried;
   if(random()<chance){
    ray=reflect(incoming,coneDirection(shading,roughness));
    if(dot(ray,normal)<=0.0)ray=reflect(ray,normal);
    carried=specular/chance;
   }else{ray=cosineDirection(normal);carried=weight/(1.0-chance);}
   eye=point+normal*1e-3;primaryRay=false;
   vec3 toward=ray,start=eye;
   float seaDistance=uOcean&&abs(ray.y)>1e-8?(uOceanHeight-eye.y)/ray.y:-1.0;
   bool submerged=uOcean&&eye.y<uOceanHeight;
   march(seaDistance>0.0?seaDistance:1e30,submerged);
   bool reachesSea=seaDistance>0.0&&!submerged&&brightest(throughput)>.001;
   bool more=bounceWeight>0.0&&b+1<uBounces;
   vec3 hitAlbedo=bounceAlbedo,hitAmbient=bounceAmbient,hitSpecular=bounceSpecular,hitPoint=bouncePoint,hitNormal=bounceNormal;
   vec3 hitLight=radiance+directLight(true),transmission=throughput;
   if(reachesSea){
    color+=carried*(hitLight+transmission*oceanRadiance(start+toward*seaDistance,toward,length(start-uCamera)+seaDistance));
    break;
   }
   if(submerged&&seaDistance>0.0&&brightest(transmission)>.001){
    color+=carried*(hitLight+transmission*oceanExitRadiance(start+toward*seaDistance,toward));
    break;
   }
   color+=carried*(hitLight+transmission*skyRadiance(toward));
   if(!more)break;
   color-=carried*hitAmbient;
   weight=carried*hitAlbedo;specular=carried*hitSpecular;point=hitPoint;normal=hitNormal;
   shading=bounceShading;incoming=bounceView;roughness=bounceRoughness;
  }
 }
 return mix(color,skyRadiance(view),fog);
#endif
}
// 输出线性亮度与权重；绘制器把多帧按权重相加，显示时除以总权重。预览帧权重更高，累积初期的噪点因此不显眼。
void main(){
 seed=pcg(uint(gl_FragCoord.x)*1973u+uint(gl_FragCoord.y)*9277u+uFrame*26699u);
 setupLight();steps=0;faceTests=0;
 vec2 jitter=uPass==1?vec2(random(),random())-.5:uJitter;
 vec3 color=tracePixel(uPicking?uPickPixel:gl_FragCoord.xy+jitter);
 if(uPicking){outColor=vec4(touched?firstDepth:-1.0,firstNormal);return;}
 if(uDebug==1)color=vec3(min(float(steps)/128.0,1.0),min(float(faceTests)/512.0,1.0),0);
 if(uDebug==2)color=vec3(float(faceTests>0),float(faceTests==0&&touched),0);
 float weight=uPass==1?1.0:4.0;
 outColor=vec4(color*weight,weight);
}
