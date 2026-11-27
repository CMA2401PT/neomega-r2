import type { MemoryWorld } from "neomega-r2-core";

/** 验证场景：在内存世界里摆方块，给出初始相机。方块用 Java 状态字符串写，与存档走同一条哈希与准备路径。 */
export interface Scene {
  label: string;
  camera: number[];
  target: number[];
  build(world: MemoryWorld): void;
}

const stone = "minecraft:stone",
  grass = 'minecraft:grass_block ["snowy"="false"]',
  quartz = "minecraft:quartz_bricks",
  fence = 'minecraft:oak_fence ["east"="true","north"="true","south"="true","west"="true"]',
  flower = "minecraft:dandelion",
  fire = 'minecraft:fire ["age"="0","east"="false","north"="false","south"="false","up"="false","west"="false"]',
  stairs = 'minecraft:quartz_stairs ["facing"="east","half"="bottom","shape"="straight"]',
  glass = "minecraft:glass",
  water = 'minecraft:water ["level"="0"]',
  leaves = 'minecraft:oak_leaves ["distance"="1","persistent"="false"]';

/** 64×64 的石头地基与草皮，场景摆在 y = 2 以上。 */
function ground(world: MemoryWorld): void {
  world.fill([0, 0, 0], [63, 0, 63], stone);
  world.fill([0, 1, 0], [63, 1, 63], grass);
}

/** 平铺一种方块，用于比较同类模型的遍历成本。 */
function field(state: string): Scene["build"] {
  return (world) => {
    ground(world);
    world.fill([8, 2, 8], [55, 2, 47], state);
  };
}

function glassWall(depth: number): Scene["build"] {
  return (world) => {
    ground(world);
    world.fill([20, 2, 24], [43, 13, 23 + depth], glass);
  };
}

const view = { camera: [32, 16, 58], target: [32, 3, 25] };

export const scenes: Record<string, Scene> = {
  frames: {
    label: "空展示框",
    camera: [40.5, 4.5, 43],
    target: [40.5, 3.5, 40.5],
    build(world) {
      ground(world);
      world.set(40, 3, 40, quartz);
      // 框体中心离支撑方块中心 17/32 格。六面共用一个子区块，每个实体都有自己的 UUID。
      const normals = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
      const entries = normals.map((normal, facing) => {
        const position = [40.5, 3.5, 40.5].map((v, i) => (v + normal[i] * 17 / 32) + "d");
        return `{id:"minecraft:item_frame",UUID:[I;0,0,0,${facing}],Facing:${facing}b,Pos:[${position}]}`;
      });
      world.setEntities([2, 0, 2], entries);
    },
  },
  special: {
    label: "附魔台、陶罐、旗帜和告示牌",
    camera: [33.5, 4, 31.5],
    target: [33.5, 3, 26.5],
    build(world) {
      ground(world);
      world.set(32, 2, 26, "minecraft:enchanting_table");
      world.fill([34, 2, 26], [34, 4, 26], fence);
      world.set(32, 2, 29, glass);
      world.set(33, 2, 28, quartz);
      world.set(35,2,26,'blue_banner ["rotation"="0"]');
      world.setBlockEntity([35,2,26],'{patterns:[{pattern:"minecraft:cross",color:"yellow"}]}');
      world.set(34,2,28,'decorated_pot ["cracked"="false","facing"="north"]');
      world.setBlockEntity([34,2,28],'{sherds:{front:{id:"minecraft:angler_pottery_sherd"}},item:{id:"minecraft:brick"}}');
      world.set(33,2,26,'oak_sign ["rotation"="0"]');
      world.setBlockEntity([33,2,26],'{front_text:{messages:["你好，世界","R2"],color:"black",has_glowing_text:1b},back_text:{messages:["背面"]}}');
      world.set(31,2,26,'command_block ["conditional"="false","facing"="north"]');
      world.setBlockEntity([31,2,26],'{Command:"say hello"}');
    },
  },
  showcase: {
    label: "综合场景",
    ...view,
    build(world) {
      ground(world);
      [quartz, fence, flower, fire, stairs, glass, water, leaves].forEach((state, i) => {
        for (let z = 14; z < 24; z += 3) world.fill([5 + i * 7, 2, z], [8 + i * 7, 2, z], state);
      });
      for (let z = 28; z < 42; z++) {
        for (let x = 10; x < 26; x++) if ((x + z) % 3 === 0) world.set(x, 2, z, flower);
        for (let x = 34; x < 50; x++) if ((x + z) % 2 === 0) world.set(x, 2, z, fence);
      }
    },
  },
  fences: { label: "密集栏杆", ...view, build: field(fence) },
  cutouts: { label: "密集花朵", ...view, build: field(flower) },
  cubes: { label: "完整立方体", ...view, build: field(quartz) },
  spill: {
    label: "伸出本格的模型",
    camera: [32, 4, 31],
    target: [32, 3, 26],
    build(world) {
      ground(world);
      for (let x = 24; x < 40; x += 2) world.set(x, 2, 26, fire);
    },
  },
  glass8: { label: "8 格厚玻璃", camera: [32, 8, 52], target: [32, 8, 28], build: glassWall(8) },
  glass16: { label: "16 格厚玻璃", camera: [32, 8, 52], target: [32, 8, 28], build: glassWall(16) },
  uniform: {
    label: "实心石块（仰视出口）",
    camera: [32, 16, 32],
    target: [32, 40, 32],
    build(world) {
      world.fill([0, 0, 0], [63, 31, 63], stone);
    },
  },
};
