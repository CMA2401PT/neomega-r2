// 实例只改变局部求交；命中排序、透明裁切和光照仍由公共射线管线负责。
uniform bool uObjectsEnabled;
layout(binding=16) uniform texture2D uObjectData;
layout(binding=17) uniform texture2D uObjectAtlas;
vec4 objectWord(int at){return texelFetch(uObjectData,ivec2(at%1024,at/1024),0);}
void intersectObject(uint handle,float begin,float end,inout Hit hit){
 if(!uObjectsEnabled)return;
 int at=int(handle&4095u)*12;uint generation=handle>>12;
 vec4 minimum=objectWord(at+4),maximum=objectWord(at+5);if(uint(minimum.w)!=generation)return;
 mat4 inverseModel=mat4(objectWord(at),objectWord(at+1),objectWord(at+2),objectWord(at+3));
 vec3 o=(inverseModel*vec4(eye,1)).xyz,d=(inverseModel*vec4(ray,0)).xyz;
 vec3 a=(minimum.xyz-o)/d,b=(maximum.xyz-o)/d,entry=min(a,b),exit=max(a,b);
 float first=max(entry.x,max(entry.y,entry.z)),last=min(exit.x,min(exit.y,exit.z));bool entering=first>=begin-EPS;float t=entering?first:last;
 if(first>last||t<begin-EPS||t>end+EPS||t>=hit.t)return;
 int axis=entering?(entry.x>=entry.y&&entry.x>=entry.z?0:entry.y>=entry.z?1:2):(exit.x<=exit.y&&exit.x<=exit.z?0:exit.y<=exit.z?1:2);
 bool plus=entering?d[axis]<0.0:d[axis]>0.0;vec3 p=(o+d*t-minimum.xyz)/(maximum.xyz-minimum.xyz);
 vec2 uv=axis==0?vec2(p.z,1.0-p.y):axis==1?p.xz:vec2(p.x,1.0-p.y);vec4 region=objectWord(at+6+axis*2+int(plus));
 if(all(equal(region.zw,vec2(0))))return;
 // 图集只有第 0 级；显式选级避免在非一致射线循环中请求屏幕导数。
 vec4 texel=textureLod(sampler2D(uObjectAtlas,tiles),region.xy+clamp(uv,vec2(.00001),vec2(.99999))*region.zw,0.0);if(texel.a<.1)return;
 faceTests++;vec3 normal=vec3(0);normal[axis]=plus?1.0:-1.0;hit.t=t;hit.color=linearColor(texel.rgb);hit.alpha=1.0;vec3 n=normalize(transpose(mat3(inverseModel))*normal);hit.material=plainMaterial(dot(n,ray)>0.0?-n:n);hit.unlit=(int(maximum.w)&(1<<(axis*2+int(plus))))!=0;
#if R2_PICK
 hit.owner=int(handle&4095u)+1;
#endif
}

// 静态三角面与覆盖格的地址表同在区域池中。记录布局与准备线程 registerMesh 一致。
vec3 meshVector(uint at){
 return uintBitsToFloat(uvec3(worldWord(at),worldWord(at+1u),worldWord(at+2u)));
}
vec2 meshUV(uint at){return uintBitsToFloat(uvec2(worldWord(at),worldWord(at+1u)));}
void intersectTriangle(uint at,ivec3 cell,float begin,float end,inout Hit hit){
 if(!uObjectsEnabled)return;
 vec3 normal=meshVector(at+4u);float facing=dot(normal,ray);
 if(abs(facing)<1e-8)return;
 ivec3 local=(cell+uDirectoryOffset)&127;
 vec3 region=vec3(cell.x-local.x,-uWorldOrigin.y,cell.z-local.z);
 vec3 origin=eye-region;
 float t=(uintBitsToFloat(worldWord(at+7u))-dot(normal,origin))/facing;
 if(t<begin-EPS||t>end+EPS||t>=hit.t)return;
 vec3 point=(origin-meshVector(at+1u))+t*ray;
 float u=dot(meshVector(at+8u),point),v=dot(meshVector(at+11u),point);
 if(min(u,v)<-1e-6||u+v>1.000001)return;
 uint flags=worldWord(at),handle=flags&0x7fffffffu;
 int slot=int(handle&4095u),instance=slot*12;
 if(uint(objectWord(instance+4).w)!=(handle>>12))return;
 vec2 uv=meshUV(at+14u)+u*meshUV(at+16u)+v*meshUV(at+18u);
 vec4 rect=objectWord(instance+6);
 ivec2 pixel=ivec2(rect.xy+clamp(floor(uv),vec2(0),rect.zw-1.0));
 vec4 texel=texelFetch(uObjectAtlas,pixel,0);
 if(texel.a<.1)return;
 faceTests++;hit.t=t;hit.color=linearColor(texel.rgb);hit.alpha=1.0;
 hit.material=plainMaterial(facing>0.0?-normal:normal);hit.unlit=(flags&0x80000000u)!=0u;
#if R2_PICK
 hit.owner=slot+1;
#endif
}
