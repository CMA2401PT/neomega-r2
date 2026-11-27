package browsermaterials

import (
	"fmt"

	"neomega-blocks/blockconv"
	"neomega-blocks/ir"
)

// stateTable 以方块哈希为键建立状态到模型的表，数据源因此只需发送哈希。
// 兼容旧状态按单层规范化后共用目标模型；含水与否只影响附加水层，方块本体共用同一模型。
// 不同状态得到相同哈希时报错，保证运行时查表不会把一种方块画成另一种。
func stateTable(java *blockconv.WaterloggedStates, models map[string]uint32) (map[uint32]uint32, error) {
	table := map[uint32]uint32{}
	owners := map[uint32]ir.IRBlock{}
	add := func(state ir.IRBlock, model uint32) error {
		state = state.Tidy()
		hash := state.Hash()
		if owner, ok := owners[hash]; ok && owner != state {
			return fmt.Errorf("方块哈希冲突：%s 与 %s 都是 %d", owner, state, hash)
		}
		owners[hash] = state
		table[hash] = model
		return nil
	}
	for state := range java.SingleLayerInputs() {
		normalized, ok := java.NormalizeSingleLayer(state)
		if !ok {
			continue
		}
		model, ok := models[string(normalized)]
		if !ok {
			continue
		}
		if err := add(state, model); err != nil {
			return nil, err
		}
		for _, value := range []string{"false", "true"} {
			variant := ir.IRBlock(state.NameWithNameSpace() + " " + string(state.States().Set("waterlogged", value)))
			if err := add(variant, model); err != nil {
				return nil, err
			}
		}
	}
	return table, nil
}
