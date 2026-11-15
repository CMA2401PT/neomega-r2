#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
precision highp usampler2D;
uniform usampler3D uCells,uTree,uSections;
uniform usampler2D uWorldData;
uniform bool uWorld;
uniform ivec3 uDirectoryOffset;
uniform int uSamples;
uniform usampler2D uModels,uParts,uTriangleIDs;
uniform sampler2D uTriangles,uFast,uAtlas,uMips;
uniform vec3 uSize,uCamera,uRight,uUp,uForward;
uniform vec2 uViewport;
uniform float uSpan;
uniform int uTop,uDebug;
uniform bool uHierarchy,uFragments;
out vec4 outColor;
const uint MIXED=0xffffffffu;
const float EPS=0.00002;
vec3 ray,invRay,accumulated;
float transmission,firstDepth;
int steps,faceTests;
bool touched;
vec3 linearColor(vec3 c){return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),greaterThan(c,vec3(0.04045)));}
vec3 srgbColor(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,greaterThan(c,vec3(0.0031308)));}
uvec4 model(uint id){return texelFetch(uModels,ivec2(int(id)%2048,int(id)/2048),0);}
vec4 table(sampler2D source,int offset){return texelFetch(source,ivec2(offset%2048,offset/2048),0);}
bool sameMedium(uint a,uint b){if(a==b)return true;return a!=0u&&b!=0u&&model(a).w!=0u&&model(a).w==model(b).w;}
void contribute(vec3 rgb,float alpha,float t,vec3 normal,bool unlit){
 if(alpha<=0.0)return;
 if(!touched){touched=true;firstDepth=t;}
 float light=unlit?1.0:0.48+0.52*max(dot(normal,normalize(vec3(0.35,0.85,0.5))),0.0);
 accumulated+=transmission*alpha*rgb*light;
 transmission*=1.0-alpha;
}
vec4 mipSample(vec2 origin,vec2 uv,float side,float level){
 float size=side*exp2(-level);
 vec2 pixel=origin+vec2(2.0*(side-size),0)+clamp(uv*size,vec2(.5),vec2(size-.5));
 return textureLod(uMips,pixel/vec2(textureSize(uMips,0)),0.0);
}
// 完整方块只需面方向与命中位置，不访问模型三角面。透明度仍只在介质边界累计。
void cubeSurface(uint id,int side,float t){
 int offset=int(model(id).y)+side*4;
 vec4 a=table(uFast,offset),b=table(uFast,offset+1),c=table(uFast,offset+2),representative=table(uFast,offset+3);
 int axis=side/2;
 if(c.y==0.0){vec3 normal=vec3(0);normal[axis]=side%2==0?-1.0:1.0;contribute(linearColor(representative.rgb),representative.a,t,normal,false);return;}
 vec3 p=fract(uCamera+ray*t);
 vec2 uv=vec2(p[(axis+1)%3],p[(axis+2)%3]);
 vec2 origin=a.xy+min(a.zw,vec2(0))+min(b.xy,vec2(0));
 vec2 extent=abs(a.zw)+abs(b.xy),local=(a.xy+a.zw*uv.x+b.xy*uv.y-origin)/extent;
 vec2 dimensions=vec2(textureSize(uMips,0));
 float minor=uSpan/uViewport.y*t*dot(ray,uForward),cosine=max(abs(ray[axis]),.05),major=minor/cosine;
 int taps=int(ceil(min(4.0,1.0/cosine)));
 vec2 direction=vec2(ray[(axis+1)%3],ray[(axis+2)%3]);direction/=max(length(direction),1e-8);
 vec2 along=(a.zw*direction.x+b.xy*direction.y)/extent*major;
 float lod=clamp(log2(max(max(minor,major/float(taps))*c.y,1e-8))-.5,0.0,log2(c.y));
 vec4 filtered=vec4(0);
 if(major*c.y<=1.0){vec4 texel=texelFetch(uMips,ivec2(origin*dimensions)+ivec2(clamp(local*c.y,vec2(0),vec2(c.y-1.0))),0);filtered=vec4(linearColor(texel.rgb)*texel.a,texel.a);}
 else for(int i=0;i<4;i++){if(i>=taps)break;vec2 at=fract(local+along*((float(i)+.5)/float(taps)-.5));vec4 lo=mipSample(origin*dimensions,at,c.y,floor(lod)),hi=mipSample(origin*dimensions,at,c.y,ceil(lod));filtered+=mix(vec4(linearColor(lo.rgb)*lo.a,lo.a),vec4(linearColor(hi.rgb)*hi.a,hi.a),fract(lod))/float(taps);}
 vec3 tint=vec3(b.zw,c.x);vec3 color=linearColor(srgbColor(filtered.rgb/max(filtered.a,1e-8))*tint);
 float alpha=mod(c.w,2.0)==1.0?filtered.a*c.z:representative.a;
 vec3 normal=vec3(0);normal[axis]=side%2==0?-1.0:1.0;
 contribute(color,alpha,t,normal,c.w>=2.0);
}
struct Hit{float t;vec3 color;float alpha;vec3 normal;bool unlit;};
// 仅在候选格子中遍历共享模型；alpha 裁切失败的面不阻挡后方更远的命中。
#include <objects>
void intersectModel(uint id,ivec3 cell,float begin,float end,inout Hit hit){
 if((id&0x80000000u)!=0u){intersectObject(id&0x7fffffffu,begin,end,hit);return;}
 uvec4 description=model(id);if(description.x!=2u)return;
 vec3 origin=uCamera-vec3(cell);
 for(uint i=0u;i<description.z;i++){
  faceTests++;
  int reference=int(description.y+i);
  int offset=int(texelFetch(uTriangleIDs,ivec2(reference%2048,reference/2048),0).r)*8;
  vec4 a=table(uTriangles,offset),b=table(uTriangles,offset+1),c=table(uTriangles,offset+2);
  vec3 crossEdge=cross(ray,c.xyz);float det=dot(b.xyz,crossEdge);if(abs(det)<1e-8)continue;
  vec3 delta=origin-a.xyz;float u=dot(delta,crossEdge)/det;if(u<0.0||u>1.0)continue;
  vec3 crossDelta=cross(delta,b.xyz);float v=dot(ray,crossDelta)/det;if(v<0.0||u+v>1.0)continue;
  float t=dot(c.xyz,crossDelta)/det;if(t<begin||t>end+EPS||t>=hit.t)continue;
  vec4 d=table(uTriangles,offset+3),normal=table(uTriangles,offset+4),region=table(uTriangles,offset+5),tint=table(uTriangles,offset+6);
  vec3 geometric=table(uTriangles,offset+7).xyz;
  if(mod(normal.w,2.0)<.5&&dot(geometric,ray)>=0.0)continue;
  vec2 uv=(1.0-u-v)*vec2(a.w,b.w)+u*vec2(c.w,d.x)+v*d.yz;
  vec2 atlasSize=vec2(textureSize(uAtlas,0));
  ivec2 pixel=ivec2((region.xy+clamp(uv,vec2(0),vec2(.999999))*region.zw)*atlasSize);
  vec4 texel=texelFetch(uAtlas,pixel,0);float alpha=texel.a*tint.w;
  if(int(d.w)==1&&alpha<.1)continue;
  if(int(d.w)!=2)alpha=1.0;
  if(alpha<=0.0)continue;
  hit.t=t;hit.color=linearColor(texel.rgb)*tint.rgb;hit.alpha=alpha;hit.normal=normal.xyz;hit.unlit=normal.w>=2.0;
 }
}
float leaveNode(vec3 lower,float width,out int side,out ivec3 nextCell){
 vec3 upper=min(lower+vec3(width),uSize);
 lower=max(lower,vec3(0));
 vec3 edge=mix(lower,upper,greaterThan(ray,vec3(0)));
 vec3 distance=(edge-uCamera)*invRay;
 for(int a=0;a<3;a++)if(abs(ray[a])<1e-8)distance[a]=1e30;
 int axis=distance.x<=distance.y&&distance.x<=distance.z?0:distance.y<=distance.z?1:2;
 side=axis*2+(ray[axis]>0.0?1:0);
 float nextTime=distance[axis];nextCell=ivec3(floor(uCamera+ray*nextTime));
 // 边界轴按整数跳到下一格，避免掠射时浮点偏移不足而反复停在同一个格子。
 for(int a=0;a<3;a++){
  if(distance[a]==nextTime)nextCell[a]=ray[a]>0.0?int(upper[a]):int(lower[a])-1;
  else nextCell[a]=clamp(nextCell[a],int(lower[a]),int(upper[a])-1);
 }
 return nextTime;
}
uint worldWord(uint offset){return texelFetch(uWorldData,ivec2(int(offset)%4096,int(offset)/4096),0).r;}
uint localIndex(ivec3 p){return uint((p.x*16+p.z)*16+p.y);}
uvec2 worldCell(ivec3 cell,uvec4 section){
 uint index=localIndex(cell&15),bits=section.z,palette=0u;
 if(bits!=0u){uint per=32u/bits;palette=(worldWord(section.x+index/per)>>((index%per)*bits))&((1u<<bits)-1u);}
 uint parts=section.w==0u?0u:worldWord(section.w+585u);
 return uvec2(worldWord(section.y+palette),parts==0u?0u:worldWord(parts+index));
}
vec3 trace(vec2 pixel){
 vec2 screen=(pixel/uViewport-.5)*vec2(uViewport.x/uViewport.y,1)*uSpan;
 ray=normalize(uForward+screen.x*uRight+screen.y*uUp);
 invRay=vec3(1)/ray;
 vec3 nearSide=(vec3(0)-uCamera)*invRay,farSide=(uSize-uCamera)*invRay;
 vec3 entry=min(nearSide,farSide),leave=max(nearSide,farSide);
 for(int a=0;a<3;a++)if(abs(ray[a])<1e-8){entry[a]=uCamera[a]>=0.0&&uCamera[a]<uSize[a]?-1e30:1e30;leave[a]=1e30;}
 float first=max(entry.x,max(entry.y,entry.z)),last=min(leave.x,min(leave.y,leave.z));
 float t=max(.01,first);int axis=entry.x>=entry.y&&entry.x>=entry.z?0:entry.y>=entry.z?1:2;
 int side=axis*2+(ray[axis]<0.0?1:0);
 accumulated=vec3(0);transmission=1.0;touched=false;steps=0;faceTests=0;firstDepth=0.0;
 float afterHit=.01;uint previous=0u;bool entering=true,inside=first<.01;bool finished=t>=last;
 ivec3 cell=clamp(ivec3(floor(uCamera+ray*(t+EPS))),ivec3(0),ivec3(uSize)-1);
 for(int iteration=0;iteration<2048;iteration++){
  if(finished)break;
  steps++;
  if(any(lessThan(cell,ivec3(0)))||any(greaterThanEqual(cell,ivec3(uSize)))){finished=true;break;}
  uvec2 contents=uvec2(0);int level=0;uint node=MIXED;
  if(uWorld){
   if(uHierarchy)for(int l=7;l>=0;l--){uint value=texelFetch(uTree,(((cell+uDirectoryOffset)>>4)&ivec3(127,31,127))>>l,l).r;if(value!=MIXED){node=value;level=l+4;break;}}
   if(node==MIXED){uvec4 section=texelFetch(uSections,((cell+uDirectoryOffset)>>4)&ivec3(127,31,127),0);
    if(uHierarchy)for(int l=3;l>=1;l--){ivec3 p=(cell&15)>>l;int side=16>>l;uint offset=l==3?576u:l==2?512u:0u;uint value=worldWord(section.w+offset+uint((p.x*side+p.z)*side+p.y));if(value!=MIXED){node=value;level=l;break;}}
    if(node==MIXED)contents=worldCell(cell,section);
   }
  }else{
   contents=texelFetch(uCells,cell,0).rg;
   if(uHierarchy)for(int l=6;l>=0;l--){if(l>uTop)continue;uint value=texelFetch(uTree,cell>>l,l).r;if(value!=MIXED){node=value;level=l;break;}}
  }
  float width=exp2(float(level));vec3 shift=uWorld?vec3(uDirectoryOffset):vec3(0);vec3 lower=floor((vec3(cell)+shift)/width)*width-shift;
  uint current=node!=MIXED?node:contents.r;
  uvec4 description=model(current);uint medium=description.x==1u?current:0u;
  int exitSide;ivec3 nextCell;float end=min(last,leaveNode(lower,width,exitSide,nextCell));
  if(entering){
   if(!inside&&!sameMedium(previous,medium)){
    if(previous!=0u)cubeSurface(previous,side^1,t);
    if(transmission>0.001&&medium!=0u)cubeSurface(medium,side,t);
   }
   inside=false;previous=medium;entering=false;
  }
  if(transmission<=.001){finished=true;break;}
  Hit hit;hit.t=end+1.0;hit.alpha=0.0;
  if(node==MIXED){
   intersectModel(current,cell,max(t,afterHit),end,hit);
   if(uFragments&&contents.g!=0u){
    int start=int(contents.g);uint count=uWorld?worldWord(uint(start)):texelFetch(uParts,ivec2(start%2048,start/2048),0).r;
    for(uint j=0u;j<count;j++){int index=start+1+int(j);uint piece=uWorld?worldWord(uint(index)):texelFetch(uParts,ivec2(index%2048,index/2048),0).r;intersectModel(piece,cell,max(t,afterHit),end,hit);}
   }
  }
  if(hit.alpha>0.0){contribute(hit.color,hit.alpha,hit.t,hit.normal,hit.unlit);if(transmission<=.001){finished=true;break;}afterHit=hit.t+EPS;t=afterHit;if(t<end-EPS)continue;}
  t=end;cell=nextCell;side=exitSide^1;entering=true;
  if(t>=last-EPS){if(previous!=0u&&transmission>.001)cubeSurface(previous,exitSide,t);finished=true;break;}
 }
 vec3 sky=mix(vec3(.32,.44,.60),vec3(.68,.78,.88),clamp(1.0-ray.y,0.0,1.0));
 vec3 color=srgbColor(accumulated+transmission*linearColor(sky));
 if(!finished)color=vec3(1,0,1);
 if(uDebug==1)color=vec3(min(float(steps)/128.0,1.0),min(float(faceTests)/512.0,1.0),0);
 if(uDebug==2)color=vec3(float(faceTests>0),float(faceTests==0&&touched),0);
 return color;
}
void main(){
 if(uSamples==1){outColor=vec4(trace(gl_FragCoord.xy),1);return;}
 vec3 sum=vec3(0);
 for(int i=0;i<4;i++){if(i>=uSamples)break;vec2 offset=uSamples==2?vec2(i==0?-.25:.25):vec2(float(i%2)-.5,float(i/2)-.5)*.5;sum+=linearColor(trace(gl_FragCoord.xy+offset));}
 outColor=vec4(srgbColor(sum/float(uSamples)),1);
}
