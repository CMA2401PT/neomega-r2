module neomega-r2link

go 1.25.5

require (
	github.com/coder/websocket v1.8.15
	neomega-blocks v0.0.0
)

require neomega-nbt v0.0.0 // indirect

replace neomega-blocks => ../../neomega-blocks

replace neomega-nbt => ../../neomega-nbt
