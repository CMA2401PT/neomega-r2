// 实例只改变局部求交；命中排序、透明裁切和光照仍由公共射线管线负责。
uniform bool uObjectsEnabled;
uniform sampler2D uObjectData,uObjectAtlas;
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
 vec4 texel=texture(uObjectAtlas,region.xy+clamp(uv,vec2(.00001),vec2(.99999))*region.zw);if(texel.a<.1)return;
 faceTests++;vec3 normal=vec3(0);normal[axis]=plus?1.0:-1.0;hit.t=t;hit.color=linearColor(texel.rgb);hit.alpha=1.0;hit.normal=normalize(transpose(mat3(inverseModel))*normal);hit.unlit=false;
}
