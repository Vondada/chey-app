-- CHE Roblox stub: VIP game pass check (ModuleScript).
-- MarketplaceService prompts require owner confirm before live use.
local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")

local GamePassStub = {}

-- Replace with the owner's real pass id after confirm.
GamePassStub.VIP_PASS_ID = 0

function GamePassStub.playerOwnsVip(player: Player): boolean
	if GamePassStub.VIP_PASS_ID == 0 then
		return false
	end
	local ok, owns = pcall(function()
		return MarketplaceService:UserOwnsGamePassAsync(player.UserId, GamePassStub.VIP_PASS_ID)
	end)
	return ok and owns == true
end

function GamePassStub.promptVip(player: Player)
	if GamePassStub.VIP_PASS_ID == 0 then
		warn("[CHE] VIP_PASS_ID not set — owner must confirm pass creation first")
		return
	end
	MarketplaceService:PromptGamePassPurchase(player, GamePassStub.VIP_PASS_ID)
end

Players.PlayerAdded:Connect(function(player)
	if GamePassStub.playerOwnsVip(player) then
		player:SetAttribute("CHE_VIP", true)
	end
end)

return GamePassStub
