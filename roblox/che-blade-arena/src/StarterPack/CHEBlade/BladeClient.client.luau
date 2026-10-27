-- CHE Blade client: on a click, finds what is in front of the player and asks the server to swing at it.
-- The client never applies damage; the server re-checks range and cooldown (ArenaServer).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local BladeConfig = require(ReplicatedStorage:WaitForChild("BladeConfig"))
local SwingRequest = ReplicatedStorage:WaitForChild("SwingRequest") :: RemoteEvent

local tool = script.Parent :: Tool
local player = Players.LocalPlayer
local lastSwing = 0

tool.Activated:Connect(function()
	local now = os.clock()
	if now - lastSwing < BladeConfig.CooldownSeconds then
		return
	end
	lastSwing = now
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not character or not root then
		return
	end
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { character }
	local result = workspace:Raycast(root.Position, root.CFrame.LookVector * BladeConfig.RangeStuds, params)
	SwingRequest:FireServer(result and result.Instance or nil)
end)
