// The strategy simulation's owner controls, by route and by chat (typed or spoken). Moved out of
// worker.js so its byte budget holds. Owner only: the Worker checks the device before it calls anything here.
// Pause and resume as before; stop also cancels waiting signals; reset asks first and archives the run (strategy_sim.js).
import { resetStrategySim, setStrategySimCeiling, setStrategySimPaused, speakStrategySim, stopStrategySim, strategySimTick, strategySimView } from './strategy_sim.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** POST /api/trading/sim { action: pause | resume | stop | reset (confirm) | tick | ceiling (usd) }. */
export async function simControlRoute(storage, body, scheduleWork) {
  const action = body?.action;
  if (action === 'pause' || action === 'resume') {
    const state = await setStrategySimPaused(storage, action === 'pause');
    // Resuming re-arms the alarm now, so the next minute is not left waiting for some other wake-up.
    if (action === 'resume') await scheduleWork();
    return json({ ok: true, state, view: await strategySimView(storage) });
  }
  if (action === 'stop') return json({ ok: true, ...(await stopStrategySim(storage)), view: await strategySimView(storage) });
  if (action === 'reset') {
    const out = await resetStrategySim(storage, { confirm: body.confirm === true });
    return json({ ...out, view: await strategySimView(storage) }, out.ok || out.needs_confirmation ? 200 : 500);
  }
  if (action === 'tick') {
    const run = await strategySimTick(storage, { force: true });
    // The first pass arms the minute cadence here, so the owner can start it without waiting for the hourly alarm.
    await scheduleWork();
    return json({ ok: true, run });
  }
  if (action === 'ceiling') {
    const result = await setStrategySimCeiling(storage, body.usd);
    return json(result, result.ok ? 200 : 400);
  }
  return json({ detail: 'Unknown action. Use pause, resume, stop, reset, tick or ceiling.' }, 400);
}

/** The spoken and shown reply to a strategySimIntent result. Every action is reported with what really happened. */
export async function simChatReply(storage, sim, scheduleWork) {
  let lead = '';
  if (sim.kind === 'pause' || sim.kind === 'resume') {
    await setStrategySimPaused(storage, sim.kind === 'pause');
    // Resuming arms the next minute at once, so it does not wait for another wake-up.
    if (sim.kind === 'resume') await scheduleWork();
    lead = sim.kind === 'pause' ? 'Paused the strategy simulation, sir. No bars are read and no trades open until you resume it.'
      : 'Resumed the strategy simulation, sir. It runs again on the next minute.';
  } else if (sim.kind === 'stop') {
    const out = await stopStrategySim(storage);
    lead = `Stopped the strategy simulation, sir: ${out.cancelled_signals} waiting signal${out.cancelled_signals === 1 ? '' : 's'} cancelled, ${out.open_positions.length} open position${out.open_positions.length === 1 ? '' : 's'} kept as they are. Say "resume the simulation" to continue.`;
  } else if (sim.kind === 'reset') {
    const out = await resetStrategySim(storage, { confirm: sim.confirm === true });
    if (out.needs_confirmation) {
      const w = out.would_archive;
      return `Reset would archive the current run (${w.trades} stored trades, ${w.open_positions} open positions) and start a fresh simulation, paused. Nothing is deleted: the run is kept as an archive. Say "yes, reset the simulation" to do it.`;
    }
    if (!out.ok) return `I did not reset the simulation, sir: ${out.error}`;
    lead = `Reset the strategy simulation, sir. The previous run (${out.archived.trades} trades) is archived as ${out.archive}; the new run is paused until you resume it.`;
  }
  const view = await strategySimView(storage);
  return [lead, speakStrategySim(view)].filter(Boolean).join('\n');
}
