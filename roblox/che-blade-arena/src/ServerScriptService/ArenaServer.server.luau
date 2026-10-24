-- CHE Blade Arena server: spawns training dummies, validates every swing, applies damage and keeps score.
-- Damage happens only here. The client asks to swing; the server checks the cooldown, that the player holds the
-- blade, and that the target is really within range before anything is hit.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local BladeConfig = require(ReplicatedStorage:WaitForChild("BladeConfig"))
local SwingRequest = ReplicatedStorage:WaitForChild("SwingRequest") :: RemoteEvent

local lastSwing: { [Player]: number } = {}

local function makeDummy(index: number): Model
	local dummy = Instance.new("Model")
	dummy.Name = "Training Dummy " .. index

	local root = Instance.new("Part")
	root.Name = "HumanoidRootPart"
	root.Size = Vector3.new(2, 2, 1)
	root.Transparency = 1
	root.CanCollide = false
	root.Parent = dummy

	local torso = Instance.new("Part")
	torso.Name = "Torso"
	torso.Size = Vector3.new(2, 2, 1)
	torso.BrickColor = BrickColor.new("Bright orange")
	torso.Parent = dummy

	local head = Instance.new("Part")
	head.Name = "Head"
	head.Size = Vector3.new(2, 1, 1)
	head.BrickColor = BrickColor.new("Bright yellow")
	head.Parent = dummy

	local angle = (index / BladeConfig.DummyCount) * math.pi * 2
	local at = Vector3.new(math.cos(angle) * BladeConfig.ArenaRadius, 3, math.sin(angle) * BladeConfig.ArenaRadius)
	root.CFrame = CFrame.new(at)
	torso.CFrame = CFrame.new(at)
	head.CFrame = CFrame.new(at + Vector3.new(0, 1.5, 0))

	local neck = Instance.new("WeldConstraint")
	neck.Part0 = torso
	neck.Part1 = head
	neck.Parent = torso
	local hip = Instance.new("WeldConstraint")
	hip.Part0 = root
	hip.Part1 = torso
	hip.Parent = root

	local humanoid = Instance.new("Humanoid")
	humanoid.MaxHealth = BladeConfig.DummyHealth
	humanoid.Health = BladeConfig.DummyHealth
	humanoid.Parent = dummy

	dummy.PrimaryPart = root
	dummy.Parent = workspace
	return dummy
end

local function spawnDummy(index: number)
	local dummy = makeDummy(index)
	local humanoid = dummy:FindFirstChildOfClass("Humanoid") :: Humanoid
	humanoid.Died:Connect(function()
		task.wait(BladeConfig.DummyRespawnSeconds)
		dummy:Destroy()
		spawnDummy(index)
	end)
end

local function addScore(player: Player)
	local stats = player:FindFirstChild("leaderstats")
	local knockouts = stats and stats:FindFirstChild("Knockouts")
	if knockouts and knockouts:IsA("IntValue") then
		knockouts.Value += 1
	end
end

Players.PlayerAdded:Connect(function(player: Player)
	local stats = Instance.new("Folder")
	stats.Name = "leaderstats"
	local knockouts = Instance.new("IntValue")
	knockouts.Name = "Knockouts"
	knockouts.Value = 0
	knockouts.Parent = stats
	stats.Parent = player
end)

Players.PlayerRemoving:Connect(function(player: Player)
	lastSwing[player] = nil
end)

SwingRequest.OnServerEvent:Connect(function(player: Player, target: Instance?)
	local now = os.clock()
	if now - (lastSwing[player] or 0) < BladeConfig.CooldownSeconds then
		return
	end
	lastSwing[player] = now

	local character = player.Character
	local held = character and character:FindFirstChildOfClass("Tool")
	if not character or not held or held.Name ~= BladeConfig.ToolName then
		return -- not holding the blade
	end
	local myRoot = character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not myRoot or typeof(target) ~= "Instance" then
		return
	end
	local model = (target :: Instance):FindFirstAncestorOfClass("Model")
	if not model or model == character then
		return
	end
	local humanoid = model:FindFirstChildOfClass("Humanoid")
	local theirRoot = model:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not humanoid or humanoid.Health <= 0 or not theirRoot then
		return
	end
	if (theirRoot.Position - myRoot.Position).Magnitude > BladeConfig.RangeStuds + 2 then
		return -- too far: a client cannot reach across the arena
	end
	humanoid:TakeDamage(BladeConfig.Damage)
	if humanoid.Health <= 0 then
		addScore(player)
	end
end)

for i = 1, BladeConfig.DummyCount do
	spawnDummy(i)
end
