--[[
  CHE Roblox studio — Weapon / Tool base (tonight first deliverable)
  Paste into a Tool's LocalScript or a ModuleScript required by the Tool.
  Owner must confirm before publish/upload. No RemoteEvents are auto-secured
  for production — harden server validation before any live experience.
]]

local Tool = script.Parent
assert(Tool and Tool:IsA("Tool"), "WeaponToolBase expects to live under a Tool")

local Players = game:GetService("Players")
local Debris = game:GetService("Debris")

-- Tunables (Nova listing can mirror these as pass-gated upgrades later)
local CONFIG = {
	DisplayName = "CHE Blade",
	Damage = 15,
	CooldownSeconds = 0.65,
	RangeStuds = 6,
	SwingDuration = 0.25,
}

local swinging = false
local lastSwing = 0

local function characterOf(player: Player): Model?
	return player.Character
end

local function humanoidOf(model: Model?): Humanoid?
	if not model then
		return nil
	end
	return model:FindFirstChildOfClass("Humanoid")
end

local function tryDamage(targetChar: Model, attacker: Player)
	local hum = humanoidOf(targetChar)
	if not hum or hum.Health <= 0 then
		return
	end
	local targetPlayer = Players:GetPlayerFromCharacter(targetChar)
	if targetPlayer and targetPlayer == attacker then
		return
	end
	-- Client-side demo only. Production: FireServer + server raycast/validate.
	hum:TakeDamage(CONFIG.Damage)
end

local function swing(player: Player)
	local now = os.clock()
	if swinging or (now - lastSwing) < CONFIG.CooldownSeconds then
		return
	end
	swinging = true
	lastSwing = now

	local char = characterOf(player)
	local root = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
	if root then
		-- Simple forward hit probe (replace with animation + Hitbox later)
		local params = RaycastParams.new()
		params.FilterType = Enum.RaycastFilterType.Exclude
		params.FilterDescendantsInstances = { char }
		local result = workspace:Raycast(root.Position, root.CFrame.LookVector * CONFIG.RangeStuds, params)
		if result and result.Instance then
			local model = result.Instance:FindFirstAncestorOfClass("Model")
			if model then
				tryDamage(model, player)
			end
		end
	end

	task.delay(CONFIG.SwingDuration, function()
		swinging = false
	end)
end

Tool.Activated:Connect(function()
	local player = Players.LocalPlayer
	if player then
		swing(player)
	end
end)

Tool.Equipped:Connect(function()
	Tool.Name = CONFIG.DisplayName
end)

return {
	Config = CONFIG,
	Swing = swing,
}
