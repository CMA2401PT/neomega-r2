/// <reference types="@webgpu/types" />
/** 从左上角起始按行紧密读回 GPU 纹理像素。大幅纹理按设备缓冲上限分批读取。 */
export async function readTexture(device: GPUDevice, texture: GPUTexture, bytes: number) {
  const row = texture.width * bytes, pitch = Math.ceil(row / 256) * 256;
  const batch = Math.min(texture.height, Math.floor(device.limits.maxBufferSize / pitch));
  const batches: { buffer: GPUBuffer; first: number; height: number }[] = [];
  const packed = new Uint8Array(row * texture.height);
  try {
    const enc = device.createCommandEncoder();
    for (let first = 0; first < texture.height; first += batch) {
      const height = Math.min(batch, texture.height - first);
      const buffer = device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      batches.push({ buffer, first, height });
      enc.copyTextureToBuffer({ texture, origin: [0, first] }, { buffer, bytesPerRow: pitch }, [texture.width, height]);
    }
    device.queue.submit([enc.finish()]);
    for (const { buffer, first, height } of batches) {
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      for (let y = 0; y < height; y++) {
        packed.set(data.subarray(y * pitch, y * pitch + row), (first + y) * row);
      }
      buffer.unmap();
    }
    return packed;
  } finally {
    for (const { buffer } of batches) buffer.destroy();
  }
}

/** 将紧密排列的 RGBA 像素（左上角原点）编码为 PNG Blob。 */
export function rgbaToPNG(rgba: Uint8Array<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(
    new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height),
    0,
    0,
  );
  return canvas.convertToBlob({ type: "image/png" });
}
