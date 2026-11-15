// 特殊对象使用共享盒体和每实例变换；每帧只更新几十个数，不重建三角面。
/**
 * @param {WebGL2RenderingContext} gl
 * @param {Map<string,WebGLUniformLocation|null>} uniforms
 * @param {number[]} size
 * @param {(unit:number,name:string,url:string,linear:boolean)=>Promise<void>} imageTexture
 */
export function createSpecial(gl, uniforms, size, imageTexture) {
  const count = 8,
    data = new Float32Array(count * 32),
    cells = new Uint32Array(size[0] * size[1] * size[2]);
  // 保守覆盖整段动画的范围，射线始终只检查当前格登记的对象。
  for (let z = 25; z <= 27; z++)
    for (let y = 2; y <= 4; y++)
      for (let x = 31; x <= 33; x++)
        cells[x + size[0] * (y + size[1] * z)] = 127;
  for (let y = 2; y <= 4; y++)
    for (let x = 35; x <= 36; x++)
      cells[x + size[0] * (y + size[1] * 26)] |= 128;
  const cellTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE9);
  gl.bindTexture(gl.TEXTURE_3D, cellTexture);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.R32UI,
    ...size,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_INT,
    cells,
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(uniforms.get("uDynamicCells"), 9);
  const table = gl.createTexture();
  gl.activeTexture(gl.TEXTURE12);
  gl.bindTexture(gl.TEXTURE_2D, table);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    64,
    1,
    0,
    gl.RGBA,
    gl.FLOAT,
    data,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(uniforms.get("uDynamic"), 12);
  const flag = document.createElement("canvas");
  flag.width = 32;
  flag.height = 64;
  const ctx = flag.getContext("2d");
  ctx.fillStyle = "#173f98";
  ctx.fillRect(0, 0, 32, 64);
  ctx.fillStyle = "#f5c643";
  ctx.fillRect(13, 0, 6, 64);
  ctx.fillRect(0, 27, 32, 8);
  ctx.clearRect(12, 49, 8, 8);
  imageTexture(13, "uBook", "/assets/book.png", false);
  imageTexture(14, "uBanner", flag.toDataURL(), false);
  const rotateY = (v, a) => [
    Math.cos(a) * v[0] + Math.sin(a) * v[2],
    v[1],
    -Math.sin(a) * v[0] + Math.cos(a) * v[2],
  ];
  const rotateZ = (v, a) => [
    Math.cos(a) * v[0] - Math.sin(a) * v[1],
    Math.sin(a) * v[0] + Math.cos(a) * v[1],
    v[2],
  ];
  /** 将共享盒体放到世界中，保存供射线求交使用的逆变换。
   * @param {number} id @param {number[]} origin @param {number[]} extent
   * @param {number[]} uv @param {number[]} pivot @param {number} angle
   * @param {number} time @param {boolean} flag
   */
  function instance(id, origin, extent, uv, pivot, angle, time, flag = false) {
    const transform = (v) =>
      flag
        ? v
        : rotateY(rotateZ(rotateY(v, angle), (80 * Math.PI) / 180), time * 0.3);
    const axes = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ].map(transform),
      scale = flag ? 1 : 1 / 16;
    const shift = flag
      ? [35.2, 2.2, 26.5]
      : rotateY(
          rotateZ(
            pivot.map((v) => v / 16),
            (80 * Math.PI) / 180,
          ),
          time * 0.3,
        ).map((v, i) => v + [32.5, 3.1 + Math.sin(time * 1.6) * 0.05, 26.5][i]);
    const at = id * 32;
    for (let column = 0; column < 3; column++)
      data.set(
        [
          axes[0][column] / scale,
          axes[1][column] / scale,
          axes[2][column] / scale,
          0,
        ],
        at + column * 4,
      );
    data.set(
      axes
        .map(
          (axis) => -axis.reduce((sum, v, i) => sum + v * shift[i], 0) / scale,
        )
        .concat(1),
      at + 12,
    );
    data.set([...origin, flag ? 1 : 0], at + 16);
    data.set(origin.map((v, i) => v + extent[i]).concat(0), at + 20);
    data.set([...uv, 0, 0], at + 24);
    data.set([...extent, 0], at + 28);
  }
  return {
    cells,
    bytes: cells.byteLength + data.byteLength,
    update(time) {
      const openness = 1.25 + Math.sin(time * 0.4) * 0.1,
        slide = Math.sin(openness);
      instance(
        0,
        [-6, -5, -0.005],
        [6, 10, 0.005],
        [0, 0],
        [0, 0, -1],
        Math.PI + openness,
        time,
      );
      instance(
        1,
        [0, -5, -0.005],
        [6, 10, 0.005],
        [16, 0],
        [0, 0, 1],
        -openness,
        time,
      );
      instance(
        2,
        [-1, -5, 0],
        [2, 10, 0.005],
        [12, 0],
        [0, 0, 0],
        Math.PI / 2,
        time,
      );
      instance(
        3,
        [0, -4, -0.99],
        [5, 8, 1],
        [0, 10],
        [slide, 0, 0],
        openness,
        time,
      );
      instance(
        4,
        [0, -4, -0.01],
        [5, 8, 1],
        [12, 10],
        [slide, 0, 0],
        -openness,
        time,
      );
      for (let i = 0; i < 2; i++)
        instance(
          5 + i,
          [0, -4, 0],
          [5, 8, 0.005],
          [24, 10],
          [slide, 0, 0],
          openness * (1 - 2 * ((time * 0.35 + i * 0.5) % 1)),
          time,
        );
      instance(
        7,
        [0, 0, -0.005],
        [1, 2, 0.01],
        [0, 0],
        [0, 0, 0],
        0,
        time,
        true,
      );
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, table);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RGBA, gl.FLOAT, data);
    },
    dispose() {
      gl.deleteTexture(cellTexture);
      gl.deleteTexture(table);
    },
  };
}
