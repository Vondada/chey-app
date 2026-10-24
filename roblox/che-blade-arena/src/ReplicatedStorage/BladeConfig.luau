-- CHE Blade Arena: shared tuning for the blade, read by the server and the client.
-- The server is the only side that applies damage; these numbers are also its limits.
local BladeConfig = {
	ToolName = "CHEBlade", -- the Tool in StarterPack (its folder name in the Rojo project)
	Damage = 20,
	CooldownSeconds = 0.6,
	RangeStuds = 7,
	DummyCount = 4,
	DummyHealth = 100,
	DummyRespawnSeconds = 5,
	ArenaRadius = 24,
}

return BladeConfig
