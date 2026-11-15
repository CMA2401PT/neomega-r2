// 动态盒体沿用同一命中排序和透明合成；对象坐标变换保持射线参数 t 不变。
uniform bool uDynamicEnabled;
uniform usampler3D uDynamicCells;
uniform sampler2D uDynamic,uBook,uBanner;
void intersectDynamic(ivec3 cell,float begin,float end,inout Hit hit){
 if(!uDynamicEnabled)return;
 uint mask=texelFetch(uDynamicCells,cell,0).r;
 for(int i=0;i<8;i++){
  if((mask&(1u<<uint(i)))==0u)continue;faceTests++;
  mat4 inverseModel=mat4(texelFetch(uDynamic,ivec2(i*8,0),0),texelFetch(uDynamic,ivec2(i*8+1,0),0),texelFetch(uDynamic,ivec2(i*8+2,0),0),texelFetch(uDynamic,ivec2(i*8+3,0),0));
  vec4 minimum=texelFetch(uDynamic,ivec2(i*8+4,0),0),maximum=texelFetch(uDynamic,ivec2(i*8+5,0),0);
  vec3 o=(inverseModel*vec4(uCamera,1)).xyz,d=(inverseModel*vec4(ray,0)).xyz;
  vec3 a=(minimum.xyz-o)/d,b=(maximum.xyz-o)/d,entry=min(a,b),exit=max(a,b);
  float first=max(entry.x,max(entry.y,entry.z)),last=min(exit.x,min(exit.y,exit.z));
  // 跨格的活动表面可能正好落在区间端点；跳跃与逐格累加的舍入必须使用同一容差。
  bool entering=first>=begin-EPS;float t=entering?first:last;
  if(first>last||t<begin-EPS||t>end+EPS||t>=hit.t)continue;
  vec3 boundary=entering?entry:exit;
  int axis=entering?(entry.x>=entry.y&&entry.x>=entry.z?0:entry.y>=entry.z?1:2):(exit.x<=exit.y&&exit.x<=exit.z?0:exit.y<=exit.z?1:2);
  vec3 p=o+d*t-minimum.xyz,extent=maximum.xyz-minimum.xyz;vec2 uv;
  vec4 texel;
  if(minimum.w==1.0){uv=vec2(p.x/extent.x,1.0-p.y/extent.y);texel=texture(uBanner,uv);}
  else{
   vec2 base=texelFetch(uDynamic,ivec2(i*8+6,0),0).xy;bool plus=(entering?d[axis]<0.0:d[axis]>0.0);
   if(axis==0)uv=base+vec2(plus?extent.z+extent.x:0.0,extent.z)+vec2(p.z,extent.y-p.y);
   else if(axis==1)uv=base+vec2(plus?extent.z:extent.z+extent.x,0.0)+p.xz;
   else uv=base+vec2(plus?2.0*extent.z+extent.x:extent.z,extent.z)+vec2(p.x,extent.y-p.y);
   texel=texture(uBook,uv/vec2(64,32));
  }
  if(texel.a<.1)continue;vec3 normal=vec3(0);normal[axis]=entering?-sign(d[axis]):sign(d[axis]);
  hit.t=t;hit.color=linearColor(texel.rgb);hit.alpha=1.0;hit.normal=normalize(transpose(mat3(inverseModel))*normal);hit.unlit=false;
 }
}
