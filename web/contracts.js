/** 公共数据契约；只提供类型，渲染核心与来源适配器通过这些数据交换场景。 */

/** @typedef {[number, number, number]} Vec3 三维坐标或方向。 */
/** @typedef {{key:string, kind:string, position:Vec3, data?:unknown, replace?:boolean}} ObjectDescriptor 特殊对象描述；data 由同类型工厂解释。 */
/** @typedef {{url:string} | {pixels:Uint8Array, width:number, height:number}} ObjectTexture 可共享的图片，或处理器生成的私有像素。 */
/** @typedef {{minimum:Vec3, maximum:Vec3, faces:Array<[number,number,number,number]>}} ObjectPart 盒体局部范围及六面的像素 UV 矩形。面顺序为 -X、+X、-Y、+Y、-Z、+Z。 */
/** @typedef {{axes:[Vec3,Vec3,Vec3],position:Vec3,scale?:number}} ObjectPose 正交旋转轴、相对拥有者的位移和统一缩放。 */
/** @typedef {{texture:ObjectTexture,bounds:[Vec3,Vec3],parts:ObjectPart[],pose:(time:number,partIndex:number)=>ObjectPose}} ObjectRecipe 对象工厂产物；bounds 必须覆盖整个动画，相对 descriptor.position。 */
/** @typedef {(descriptor:ObjectDescriptor)=>ObjectRecipe|Promise<ObjectRecipe>} ObjectFactory 外观实现无需接触 WebGL 或存档读取。 */
/** @typedef {{key:string,owner:Vec3,replace:boolean,bounds:[Vec3,Vec3],ids:number[]}} ObjectReference 格子准备器使用的活动部件候选。 */
/** @typedef {{position:Vec3,bits:number,palette:Uint32Array,words:Uint32Array}} SourceSection 压缩 section；palette 保存唯一的静态模型编号，格子索引为 XZY。 */
/** @typedef {{sections:SourceSection[],unknown:number,bytes:number}} SourceRegion 8×8 区块区域的输入数据。 */
/** @typedef {{sections:number,prepareMS:number}} RegionStatistics 已准备区域的统计。 */
/** @typedef {{key:string,x:number,z:number,words:Uint32Array,headers:Uint32Array,relocations:Uint32Array,stats:RegionStatistics}} PreparedRegion 可增量上传的区域。headers 每 7 项描述一个 section：[区内编号, 附加块地址, 压缩字地址, 位宽, 小块掩码低 32 位, 高 32 位, 均匀编号]，附加块地址为 0 表示整个 section 是同一完整方块或空气；relocations 指出 words 内需要加上显存基址的地址项。 */
export {};
