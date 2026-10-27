// NinjaTrader / Tradovate MCP endpoints. Demo is the only allowed default.
// No credentials or order execution are performed by this discovery helper.
export const NINJATRADER_MCP = Object.freeze({
  demo: 'https://mcp-demo.tradovateapi.com/mcp',
  live: 'https://mcp-live.tradovateapi.com/mcp',
});
export function ninjaTraderMcpConfig(environment = 'demo') {
  if (environment !== 'demo' && environment !== 'live') throw new Error('Invalid NinjaTrader MCP environment');
  return {
    environment,
    url: NINJATRADER_MCP[environment],
    transport: 'streamable-http',
    requires_user_oauth: true,
    connected: false,
    order_execution_enabled: false,
    approval_required: true,
  };
}
// This is a capability declaration, NOT a connection test or an OAuth session.
// A production connection must implement PKCE, owner-bound encrypted token
// storage, MCP tool discovery, least-privilege permissions, and audit logging.
