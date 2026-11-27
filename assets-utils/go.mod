module neomega-view-utils/r2assets

go 1.25.5

require neomega-blocks v0.0.0

require (
	neomega-nbt v0.0.0 // indirect
	neomega-view-utils/fixer v0.0.0
)

replace neomega-blocks => ../../neomega-blocks

replace neomega-nbt => ../../neomega-nbt

replace neomega-view-utils/fixer => ../fix-utils
