// 演示服务、贴图测试和 Viewer 离线导出共用 Go 内嵌的默认资源归档。
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

export const defaultAssets = new AdmZip(fileURLToPath(new URL("../../assets-utils/default-materials.zip", import.meta.url)));

/** 将归档条目的 DEFLATE 数据封装为 gzip，让演示服务直接发送已压缩的资源。 */
export function gzipAsset(entry) {
  const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(entry.header.crc, 0);
  trailer.writeUInt32LE(entry.header.size, 4);
  return Buffer.concat([header, entry.getCompressedData(), trailer]);
}
