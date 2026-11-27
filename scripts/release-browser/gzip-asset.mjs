/** 将归档条目的 DEFLATE 数据封装为 gzip，让演示服务直接发送已压缩的资源。 */
export function gzipAsset(entry) {
  const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(entry.header.crc, 0);
  trailer.writeUInt32LE(entry.header.size, 4);
  return Buffer.concat([header, entry.getCompressedData(), trailer]);
}
