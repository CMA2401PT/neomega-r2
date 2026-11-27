package fixer

import (
	"iter"

	"neomega-blocks/blockconv"
	"neomega-blocks/ir"
	"neomega-view-utils/fixer/solidtable"
)

// HorizontalBounds 按 X、Z 给出中心的水平范围，Min 包含、Max 不包含。
// 树叶用它保守处理可能由区域外原木维持的格子。
type HorizontalBounds struct{ Min, Max [2]int }

// Input 将规则与存储分离。Blocks 仅遍历 accept 命中的中心格子，Get 查询中心及周围的原始数据。
// Blocks 可按调色板预筛选；accept 只看状态，存储方不需要了解具体修复规则。
// 缺失格必须返回空气和 false；整个调用期间输入保持不变。
type Input struct {
	Blocks func(accept func(ir.IRBlock) bool) iter.Seq2[[3]int, ir.IRBlock]
	Get    func(x, y, z int) (ir.IRBlock, bool)
	Bounds HorizontalBounds
}

type position struct{ x, y, z int }
type blockGetter func(x, y, z int) (ir.IRBlock, bool)
type target struct {
	pos   position
	state ir.IRBlock
}
type snapshot struct {
	get     blockGetter
	solid   map[ir.IRBlock]uint8
	targets []target
	bounds  HorizontalBounds
}

type pass struct {
	cares func(ir.IRBlock) bool
	run   func(snapshot) map[position]ir.IRBlock
}

type Fixer struct {
	schema blockconv.Schema
	states *blockconv.WaterloggedStates
	canon  *blockconv.CanonBlock[ir.IRBlock]
	solid  solidtable.Table
	passes []pass
}

// New 使用宿主选定的状态、默认属性和六面实心表构造邻接修复器。
func New(solid solidtable.Table, schema blockconv.Schema, states *blockconv.WaterloggedStates, canon *blockconv.CanonBlock[ir.IRBlock]) *Fixer {
	f := &Fixer{solid: solid, schema: schema, states: states, canon: canon}
	f.passes = []pass{
		{cares: connectionTarget, run: f.connections},
		{cares: fireTarget, run: f.fireConnections},
		{cares: stairTarget, run: f.stairShapes},
		{cares: doorTarget, run: f.doorHalves},
		{cares: snowyTarget, run: f.snowyGround},
		{cares: redstoneTarget, run: f.redstoneConnections},
		{cares: leafTarget, run: f.leafDistances},
		{cares: plantTarget, run: f.plantHeads},
		{cares: campfireTarget, run: f.campfireSignal},
		{cares: noteBlockTarget, run: f.noteBlockInstrument},
	}
	return f
}

// Fix 返回中心格子的最终修改，输入和邻居均不写入；调用方决定如何保存修改。
// 默认属性按状态缓存，规则逐轮看见中心的最新状态，邻居始终保持原始快照。
func (f *Fixer) Fix(input Input) map[[3]int]ir.IRBlock {
	completed := make(map[ir.IRBlock]ir.IRBlock)
	complete := func(state ir.IRBlock) ir.IRBlock {
		value, found := completed[state]
		if !found {
			value = f.completeBlock(state)
			completed[state] = value
		}
		return value
	}
	changes := make(map[[3]int]ir.IRBlock)
	var candidates []position
	relevant := make(map[ir.IRBlock]bool)
	// 筛选允许存储方先检查调色板，整片无目标数据无需逐格展开。
	accept := func(original ir.IRBlock) bool {
		state := complete(original)
		active, found := relevant[state]
		if !found {
			for _, pass := range f.passes {
				active = active || pass.cares(state)
			}
			relevant[state] = active
		}
		return active || state != original
	}
	for pos, original := range input.Blocks(accept) {
		state := complete(original)
		if state != original {
			changes[pos] = state
		}
		if relevant[state] {
			candidates = append(candidates, position{pos[0], pos[1], pos[2]})
		}
	}
	view := snapshot{solid: make(map[ir.IRBlock]uint8), bounds: input.Bounds}
	view.get = func(x, y, z int) (ir.IRBlock, bool) {
		if state, found := changes[[3]int{x, y, z}]; found {
			return state, true
		}
		state, found := input.Get(x, y, z)
		return complete(state), found
	}
	for _, pass := range f.passes {
		view.targets = view.targets[:0]
		matches := make(map[ir.IRBlock]bool)
		for _, pos := range candidates {
			state, _ := view.get(pos.x, pos.y, pos.z)
			active, found := matches[state]
			if !found {
				active = pass.cares(state)
				matches[state] = active
			}
			if active {
				view.targets = append(view.targets, target{pos, state})
			}
		}
		if len(view.targets) == 0 {
			continue
		}
		for pos, state := range pass.run(view) {
			changes[[3]int{pos.x, pos.y, pos.z}] = state
		}
	}
	for pos, state := range changes {
		original, _ := input.Get(pos[0], pos[1], pos[2])
		if state == original {
			delete(changes, pos)
		}
	}
	return changes
}

func (view snapshot) targetBlocks() iter.Seq2[position, ir.IRBlock] {
	return func(yield func(position, ir.IRBlock) bool) {
		for _, block := range view.targets {
			if !yield(block.pos, block.state) {
				return
			}
		}
	}
}

func (f *Fixer) completeBlock(block ir.IRBlock) ir.IRBlock {
	// 默认属性表不保留通用含水标记，补全时需单独传递原值。
	if _, ok := f.states.HashToBlock(block.Tidy().Hash()); ok {
		return block
	}
	states := block.States()
	waterlogged, wet := states.Get("waterlogged")
	source := ir.IRBlock(block.NameWithNameSpace() + " " + string(states.Delete("waterlogged")))
	completed, ok := f.canon.Convert(source)
	if !ok {
		return block
	}
	if wet {
		completed = ir.IRBlock(completed.NameWithNameSpace() + " " + string(completed.States().Set("waterlogged", waterlogged)))
	}
	return completed.Tidy()
}

func (f *Fixer) faces(block ir.IRBlock, cache map[ir.IRBlock]uint8) uint8 {
	// 面位按完整 Java 状态缓存，避免每个相邻格都重复计算 hash。
	if faces, exists := cache[block]; exists {
		return faces
	}
	faces := f.solid[block.Tidy().Hash()]
	cache[block] = faces
	return faces
}

func sideOffset(side int) position {
	// 方向编号与实心表的成对面位一致，异或 1 即反向。
	offset := [3]int{}
	offset[side/2] = 2*(side%2) - 1
	return position{x: offset[0], y: offset[1], z: offset[2]}
}

func neighbour(get blockGetter, pos position, side int) (ir.IRBlock, bool) {
	// 单面规则只需提供方向，跨 section 与跨区块寻址统一交给取格函数。
	delta := sideOffset(side)
	return get(pos.x+delta.x, pos.y+delta.y, pos.z+delta.z)
}
