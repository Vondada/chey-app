-- CHE Roblox stub: simple melee hit loop (ModuleScript).
-- NOT published. Owner confirm before Studio paste / upload.
local CombatStub = {}

export type HitResult = {
	target: Model?,
	damage: number,
}

function CombatStub.swing(attacker: Model, damage: number): HitResult
	damage = math.max(0, damage or 10)
	-- Placeholder: ray/overlap queries belong in the live experience.
	return {
		target = nil,
		damage = damage,
	}
end

function CombatStub.bindTool(tool: Tool, damage: number)
	tool.Activated:Connect(function()
		CombatStub.swing(tool.Parent :: Model, damage)
	end)
end

return CombatStub
