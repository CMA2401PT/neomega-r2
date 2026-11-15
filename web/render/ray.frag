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
uniform sampler2D uQuadRecords,uFast,uAtlas;
uniform sampler2DArray uSurfaces;
uniform vec3 uSize,uCamera,uRight,uUp,uForward;
uniform vec2 uViewport;
uniform float uSpan;
uniform int uSamples,uDebug;
uniform bool uHierarchy,uFragments;
out vec4 outColor;
const uint MIXED=0xffffffffu;
const float EPS=0.00002;
// 附加块布局：128 字格子掩码、64 字小块标签、1 字片段表地址，随后是调色板。
const uint AUX_TAGS=128u,AUX_PARTS=192u,AUX_PALETTE=193u;
vec3 ray,invRay,accumulated;
// rayLength 是未归一化方向的长度，用于把屏幕上一个像素换算成表面上的足迹。
float transmission,firstDepth,rayLength;
int steps,faceTests;
bool touched;
vec3 linearColor(vec3 c){return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),greaterThan(c,vec3(0.04045)));}
vec3 srgbColor(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,greaterThan(c,vec3(0.0031308)));}
// 按轴取分量时不用 v[axis]：ANGLE 在 D3D 上会把动态下标翻译成可索引临时数组，很慢。
float pick(vec3 v,int axis){return axis==0?v.x:axis==1?v.y:v.z;}
vec2 across(vec3 v,int axis){return axis==0?v.yz:axis==1?v.zx:v.xy;}
vec3 axisNormal(int side){vec3 n=vec3(equal(ivec3(side/2),ivec3(0,1,2)));return side%2==0?-n:n;}
uvec4 model(uint id){return texelFetch(uModels,ivec2(int(id)%2048,int(id)/2048),0);}
vec4 table(sampler2D source,int offset){return texelFetch(source,ivec2(offset%2048,offset/2048),0);}
uint worldWord(uint offset){return texelFetch(uWorldData,ivec2(int(offset)%4096,int(offset)/4096),0).r;}
// 模型头的 w 是介质组，同组的玻璃或水之间不画接缝；调用方传入已读取的模型头，避免重复查表。
bool sameMedium(uint a,uint groupA,uint b,uint groupB){return a==b||(a!=0u&&b!=0u&&groupA!=0u&&groupA==groupB);}
void contribute(vec3 rgb,float alpha,float t,vec3 normal,bool unlit){
 if(alpha<=0.0)return;
 if(!touched){touched=true;firstDepth=t;}
 float light=unlit?1.0:0.48+0.52*max(dot(normal,normalize(vec3(0.35,0.85,0.5))),0.0);
 accumulated+=transmission*alpha*rgb*light;
 transmission*=1.0-alpha;
}
// 完整方块只需面方向与命中位置，不访问模型表面。透明度仍只在介质边界累计。
// 面表每面 4 项：贴图空间原点与 u 方向、v 方向与层号（负数为纯色）与标志、线性色调与不透明度系数、代表色。
void cubeSurface(uint fastOffset,int side,float t){
 int offset=int(fastOffset)+side*4;
 vec4 f0=table(uFast,offset),f1=table(uFast,offset+1),f2=table(uFast,offset+2);
 vec3 normal=axisNormal(side);
 if(f1.z<0.0){vec4 color=table(uFast,offset+3);contribute(linearColor(color.rgb),color.a,t,normal,false);return;}
 int axis=side/2;
 vec2 uv=across(fract(uCamera+ray*t),axis);
 vec2 tile=f0.xy+f0.zw*uv.x+f1.xy*uv.y;
 // 射线微分：相邻像素的射线在这个面上相距多远，决定 mip 级与各向异性方向。
 float pixel=uSpan/uViewport.y,scale=t/rayLength,facing=pick(ray,axis);
 vec3 dx=scale*pixel*(uRight-ray*pick(uRight,axis)/facing),dy=scale*pixel*(uUp-ray*pick(uUp,axis)/facing);
 vec2 sx=across(dx,axis),sy=across(dy,axis);
 vec4 texel=textureGrad(uSurfaces,vec3(tile,f1.z),f0.zw*sx.x+f1.xy*sx.y,f0.zw*sy.x+f1.xy*sy.y);
 vec3 color=texel.rgb/max(texel.a,1e-4)*f2.rgb;
 float alpha=mod(f1.w,2.0)==1.0?texel.a*f2.w:table(uFast,offset+3).a;
 contribute(color,alpha,t,normal,f1.w>=2.0);
}
struct Hit{float t;vec3 color;float alpha;vec3 normal;bool unlit;};
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
 vec3 origin=uCamera-vec3(cell);
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
  hit.t=t;hit.color=linearColor(texel.rgb)*tint.rgb;hit.alpha=alpha;hit.normal=table(uQuadRecords,offset+6).xyz;hit.unlit=b.w>=2.0;
 }
}
// 求射线离开轴对齐节点的时间；落在边界上的轴按整数跳到下一格，避免掠射时反复停在同一格。
float leaveNode(ivec3 lowerCell,int width,out int side,out ivec3 nextCell){
 vec3 lower=max(vec3(lowerCell),vec3(0)),upper=min(vec3(lowerCell+width),uSize);
 vec3 distance=(mix(lower,upper,greaterThan(ray,vec3(0)))-uCamera)*invRay;
 distance=mix(distance,vec3(1e30),lessThan(abs(ray),vec3(1e-8)));
 int axis=distance.x<=distance.y&&distance.x<=distance.z?0:distance.y<=distance.z?1:2;
 float next=min(distance.x,min(distance.y,distance.z));
 side=axis*2+(pick(ray,axis)>0.0?1:0);
 ivec3 lo=ivec3(lower),hi=ivec3(upper);
 ivec3 inside=clamp(ivec3(floor(uCamera+ray*next)),lo,hi-1);
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
uint locate(ivec3 cell,out int level,out bool cellLevel,out uint parts){
 level=0;cellLevel=false;parts=0u;
 ivec3 directory=(cell+uDirectoryOffset)>>4;
 if(cell>>4!=cachedSection){
  cachedSection=cell>>4;cachedBrick=-1;
  section=texelFetch(uSections,directory&ivec3(255,31,255),0);
  partsBase=section.x!=0u&&uFragments?worldWord(section.x+AUX_PARTS):0u;
 }
 if(section.x==0u){
  if(!uHierarchy)return section.y;
  // 均匀 section 向上查目录层次，直到父节点不再均匀。
  level=4;
  for(int l=1;l<=8;l++){if(texelFetch(uTree,(directory&ivec3(255,31,255))>>l,l).r!=section.y)break;level=l+4;}
  return section.y;
 }
 ivec3 local=cell&15;
 int brick=((local.x>>2)*4+(local.z>>2))*4+(local.y>>2);
 if(!maskBit(section.zw,brick)){level=uHierarchy?2:0;return 0u;}
 if(brick!=cachedBrick){
  cachedBrick=brick;
  uint at=section.x+uint(brick*2);
  cellMask=uvec2(worldWord(at),worldWord(at+1u));
  brickTag=worldWord(section.x+AUX_TAGS+uint(brick));
 }
 if(brickTag!=MIXED){level=uHierarchy?2:0;return brickTag;}
 if(!maskBit(cellMask,((local.x&3)*4+(local.z&3))*4+(local.y&3)))return 0u;
 cellLevel=true;
 uint index=localIndex(local),bits=section.y>>27,palette=0u;
 if(bits!=0u){uint per=32u/bits;palette=(worldWord((section.y&0x7ffffffu)+index/per)>>((index%per)*bits))&((1u<<bits)-1u);}
 if(partsBase!=0u)parts=worldWord(partsBase+index);
 return worldWord(section.x+AUX_PALETTE+palette);
}
// 返回线性颜色；调试计数留在全局变量里。
vec3 trace(vec2 pixel){
 vec2 screen=(pixel/uViewport-.5)*vec2(uViewport.x/uViewport.y,1)*uSpan;
 vec3 direction=uForward+screen.x*uRight+screen.y*uUp;
 rayLength=length(direction);ray=direction/rayLength;
 invRay=vec3(1)/ray;
 bvec3 parallel=lessThan(abs(ray),vec3(1e-8));
 vec3 nearSide=(vec3(0)-uCamera)*invRay,farSide=(uSize-uCamera)*invRay;
 vec3 entry=min(nearSide,farSide),leave=max(nearSide,farSide);
 bvec3 within=bvec3(vec3(greaterThanEqual(uCamera,vec3(0)))*vec3(lessThan(uCamera,uSize)));
 entry=mix(entry,mix(vec3(1e30),vec3(-1e30),within),parallel);
 leave=mix(leave,vec3(1e30),parallel);
 float first=max(entry.x,max(entry.y,entry.z)),last=min(leave.x,min(leave.y,leave.z));
 float t=max(.01,first);int axis=entry.x>=entry.y&&entry.x>=entry.z?0:entry.y>=entry.z?1:2;
 int side=axis*2+(pick(ray,axis)<0.0?1:0);
 accumulated=vec3(0);transmission=1.0;touched=false;steps=0;faceTests=0;firstDepth=0.0;
 cachedSection=ivec3(-1);cachedBrick=-1;
 float afterHit=.01;uint previous=0u;uvec4 previousModel=uvec4(0);bool entering=true,inside=first<.01;bool finished=t>=last;
 ivec3 cell=clamp(ivec3(floor(uCamera+ray*(t+EPS))),ivec3(0),ivec3(uSize)-1);
 for(int iteration=0;iteration<2048;iteration++){
  if(finished)break;
  steps++;
  if(any(lessThan(cell,ivec3(0)))||any(greaterThanEqual(cell,ivec3(uSize)))){finished=true;break;}
  int level;bool cellLevel;uint parts;
  uint current=locate(cell,level,cellLevel,parts);
  int width=1<<level;
  ivec3 lower=((cell+uDirectoryOffset)&ivec3(~(width-1)))-uDirectoryOffset;
  uvec4 description=current==0u?uvec4(0):model(current);
  uint medium=description.x==1u?current:0u;if(medium==0u)description=uvec4(0);
  int exitSide;ivec3 nextCell;float end=min(last,leaveNode(lower,width,exitSide,nextCell));
  if(entering){
   if(!inside&&!sameMedium(previous,previousModel.w,medium,description.w)){
    if(previous!=0u)cubeSurface(previousModel.y,side^1,t);
    if(transmission>0.001&&medium!=0u)cubeSurface(description.y,side,t);
   }
   inside=false;previous=medium;previousModel=description;entering=false;
  }
  if(transmission<=.001){finished=true;break;}
  Hit hit;hit.t=end+1.0;hit.alpha=0.0;
  if(cellLevel){
   intersectModel(current,cell,max(t,afterHit),end,hit);
   if(parts!=0u){
    uint count=worldWord(parts);
    for(uint j=0u;j<count;j++)intersectModel(worldWord(parts+1u+j),cell,max(t,afterHit),end,hit);
   }
  }
  if(hit.alpha>0.0){contribute(hit.color,hit.alpha,hit.t,hit.normal,hit.unlit);if(transmission<=.001){finished=true;break;}afterHit=hit.t+EPS;t=afterHit;if(t<end-EPS)continue;}
  t=end;cell=nextCell;side=exitSide^1;entering=true;
  if(t>=last-EPS){if(previous!=0u&&transmission>.001)cubeSurface(previousModel.y,exitSide,t);finished=true;break;}
 }
 vec3 sky=mix(vec3(.32,.44,.60),vec3(.68,.78,.88),clamp(1.0-ray.y,0.0,1.0));
 if(!finished)return vec3(1,0,1);
 return accumulated+transmission*linearColor(sky);
}
void main(){
 vec3 sum=vec3(0);
 for(int i=0;i<4;i++){
  if(i>=uSamples)break;
  vec2 offset=uSamples==1?vec2(0):uSamples==2?vec2(i==0?-.25:.25):vec2(float(i%2)-.5,float(i/2)-.5)*.5;
  sum+=trace(gl_FragCoord.xy+offset);
 }
 outColor=vec4(srgbColor(sum/float(uSamples)),1);
 if(uDebug==1)outColor.rgb=vec3(min(float(steps)/128.0,1.0),min(float(faceTests)/512.0,1.0),0);
 if(uDebug==2)outColor.rgb=vec3(float(faceTests>0),float(faceTests==0&&touched),0);
}
