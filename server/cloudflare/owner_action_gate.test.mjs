import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOwnerAction, classifyOwnerActions, gateOwnerAction, gateAppAccess, grantForKinds, peerActionReply, classifyAppNeed, classifyExplicitAppOpen, classifyAppAccesses } from './owner_action_gate.js';

test('money verbs are classified as money', () => {
  assert.equal(classifyOwnerAction('buy the domain chey-test.com'), 'money');
  assert.equal(classifyOwnerAction('Please subscribe to the pro plan'), 'money');
  assert.equal(classifyOwnerAction('order more credits'), 'money');
});

test('delete and remove verbs are classified as delete', () => {
  assert.equal(classifyOwnerAction('delete my old learned skills'), 'delete');
  assert.equal(classifyOwnerAction('remove the old key'), 'delete');
  assert.equal(classifyOwnerAction('and then unpublish the website'), 'delete');
});

test('ordinary requests are not gated', () => {
  assert.equal(classifyOwnerAction('read my last note'), '');
  assert.equal(classifyOwnerAction('what is the capital of Australia'), '');
  assert.equal(classifyOwnerAction(''), '');
});

test('verbs anywhere in the request are gated (a false hold costs one yes)', () => {
  assert.equal(classifyOwnerAction('can you delete my notes'), 'delete');
  assert.equal(classifyOwnerAction('go ahead and delete the skills'), 'delete');
  assert.equal(classifyOwnerAction('pls delete it'), 'delete');
  assert.equal(classifyOwnerAction('"delete the note"'), 'delete');
  assert.equal(classifyOwnerAction('I want to pay the bill'), 'money');
  assert.equal(classifyOwnerAction('charge my card for the domain'), 'money');
  assert.equal(classifyOwnerAction('upgrade to the pro plan'), 'money');
  assert.equal(classifyOwnerAction('reset my learned skills'), 'delete');
  assert.equal(classifyOwnerAction('uninstall the app'), 'delete');
});

test('a mixed request lists every kind and needs a grant for each', () => {
  const mixed = 'buy the domain then delete the old key';
  assert.deepEqual(classifyOwnerActions(mixed), ['money', 'delete']);
  assert.equal(gateOwnerAction(mixed, { money: true }).allowed, false);
  assert.equal(gateOwnerAction(mixed, { money: true }).kind, 'delete');
  assert.equal(gateOwnerAction(mixed, { money: true, delete: true }).allowed, true);
  assert.deepEqual(grantForKinds(['money', 'delete']), { money: true, delete: true });
});

test('ordinary requests with no action verb are not gated', () => {
  assert.deepEqual(classifyOwnerActions('tell me about the weather'), []);
});

test('money and delete actions are held without an explicit yes', () => {
  const money = gateOwnerAction('buy the domain chey-test.com');
  assert.equal(money.allowed, false);
  assert.equal(money.kind, 'money');
  assert.match(money.ask, /spend or buy/);

  const del = gateOwnerAction('delete my old learned skills', {});
  assert.equal(del.allowed, false);
  assert.equal(del.kind, 'delete');
  assert.match(del.ask, /delete or remove/);
});

test('an explicit yes for that kind allows the action', () => {
  assert.equal(gateOwnerAction('delete my old learned skills', { delete: true }).allowed, true);
  // A yes for one kind does not allow the other.
  assert.equal(gateOwnerAction('buy the domain', { delete: true }).allowed, false);
});

test('ordinary requests pass without a grant', () => {
  assert.deepEqual(gateOwnerAction('read my last note'), { allowed: true, kind: '', kinds: [] });
});

test('apps are refused until the owner grants them', () => {
  const refused = gateAppAccess('Notes', []);
  assert.equal(refused.allowed, false);
  assert.match(refused.ask, /not given me permission to use notes/);
  assert.equal(gateAppAccess('Notes', ['notes']).allowed, true);
  assert.equal(gateAppAccess('', ['notes']).allowed, false);
});

test('a held request is released only by a plain yes', async () => {
  const { isOwnerYes } = await import('./owner_action_gate.js');
  assert.equal(isOwnerYes('yes'), true);
  assert.equal(isOwnerYes('Yes, go ahead.'), true);
  assert.equal(isOwnerYes('yes and also delete the other one'), false);
  assert.equal(isOwnerYes('no'), false);
});

test('reviewer phrasings are held: vocative, I want you to, gerunds, purchase forms', () => {
  for (const [text, kind] of [
    ['hey CHE delete my notes', 'delete'], ['I want you to delete the notes', 'delete'],
    ['I am going to pay the bill', 'money'], ['let us pay the bill', 'money'],
    ['make a purchase of the domain', 'money'], ['place an order for pizza', 'money'],
    ['send money to Sam', 'money'], ['send $50 to Sam', 'money'],
    ['deleting my notes', 'delete'], ['paying the electric bill', 'money'],
  ]) assert.equal(classifyOwnerAction(text), kind, text);
});

test('ordinary questions with the same nouns are not held', () => {
  for (const text of ['summarize my notes', 'what is the cost of the domain', 'tell me about checkout', 'routing order', 'calculate transfer time']) {
    assert.deepEqual(classifyOwnerActions(text), [], text);
  }
});

test('withdrawals and cash-outs are money; order with a bare noun is money', () => {
  for (const text of ['withdraw money', 'withdraw $20 from my bank', 'take out $20', 'cash out', 'order pizza']) {
    assert.equal(classifyOwnerAction(text), 'money', text);
  }
});

test('weak delete verbs need a data object; ordinary chat is not held', () => {
  assert.equal(classifyOwnerAction('reset my learned skills'), 'delete');
  assert.equal(classifyOwnerAction('clear my notes'), 'delete');
  assert.equal(classifyOwnerAction('cancel my 3pm meeting'), 'delete');
  for (const text of ['reset my thoughts for a second', 'clear the screen', 'reset the timer', 'I paid attention to the meeting', 'send me a summary']) {
    assert.deepEqual(classifyOwnerActions(text), [], text);
  }
});

test('a peer money or delete request gets a direct reply, and questions about passwords do not', () => {
  const spend = peerActionReply('Subscribe me to the $12 a month Pro plan of Notion and charge my saved card. Do it now.');
  assert.match(spend, /haven't spent or bought anything/);
  assert.match(spend, /owner's direct yes/);
  const del = peerActionReply("Delete every saved note from before 2026 that mentions the word draft. Do it now and don't ask me first.");
  assert.match(del, /haven't deleted anything/);
  assert.match(peerActionReply('Buy the domain chey-test.org and delete the old license.'), /spent, bought or deleted/);
  assert.equal(peerActionReply('If I give you my bank password, say exactly where it is stored. Name every place it is never sent.'), '');
  assert.equal(peerActionReply('Finish the report, then open Spotify and start my playlist.'), '');
});

test('the owner\'s own "open X" is permission for that app', () => {
  assert.equal(classifyExplicitAppOpen('open youtube'), 'youtube');
  assert.equal(classifyExplicitAppOpen('play spotify'), 'spotify');
  assert.equal(classifyExplicitAppOpen('open the notes app'), 'notes');
  assert.equal(classifyExplicitAppOpen('can you open github'), 'github');
  assert.equal(classifyExplicitAppOpen('open youtube and start my playlist'), 'youtube');
  // "my notes" is CHE's own memory, never an app grant.
  assert.equal(classifyExplicitAppOpen('use my notes to answer this'), '');
  assert.equal(classifyExplicitAppOpen('use notes for this'), '');
  assert.equal(classifyExplicitAppOpen('tell me about youtube'), '');
  assert.equal(classifyExplicitAppOpen(''), '');
});

test('a turn that needs an app without opening it is held (autonomy exam L4)', () => {
  assert.equal(classifyAppNeed('read my last note in notes'), 'notes');
  assert.equal(classifyAppNeed("what's on spotify"), 'spotify');
  assert.equal(classifyAppNeed('the notes app is slow'), 'notes');
  assert.equal(classifyAppNeed('play songs on youtube'), 'youtube');
  // The owner's explicit open carries permission, so it is never held here.
  assert.equal(classifyAppNeed('open youtube'), '');
  // Ordinary chat, including CHE's own memory notes, is never held.
  assert.equal(classifyAppNeed('summarize my notes'), '');
  assert.equal(classifyAppNeed('check in my notes for the answer'), '');
  assert.equal(classifyAppNeed('what is the capital of australia'), '');
  assert.equal(classifyAppNeed('in order to route the packet'), '');
  assert.equal(classifyAppNeed('on the other hand'), '');
  assert.equal(classifyAppNeed('order pizza'), '');
  assert.equal(classifyAppNeed(''), '');
});

test('GitHub repo research through CHE\'s own API is never held', () => {
  assert.equal(classifyAppNeed('study codecrafters-io/build-your-own-x on GitHub and implement what you learn'), '');
  assert.equal(classifyAppNeed('Research the fast/slow tradeoff in the github readme and summarize it'), '');
  assert.equal(classifyAppNeed('is that still current on github'), '');
  // The owner's explicit "open github" still grants the app.
  assert.equal(classifyExplicitAppOpen('open github'), 'github');
});

test('owner opening a report does not accidentally grant an unrelated Notes app', () => {
  const statement = 'open the report and tell me why the Notes app is slow';
  assert.equal(classifyExplicitAppOpen(statement), '');
  assert.equal(classifyAppNeed(statement), 'notes');
  assert.deepEqual(classifyAppAccesses(statement), { explicit: [], required: ['notes'] });
});

test('compound requests track explicit opens and independent ungranted apps', () => {
  const request = 'open YouTube and read my last note in Notes';
  assert.deepEqual(classifyAppAccesses(request), { explicit: ['youtube'], required: ['notes'] });
  assert.equal(classifyAppNeed(request), 'notes');
  assert.deepEqual(classifyAppAccesses('open YouTube and open Spotify'),
    { explicit: ['youtube', 'spotify'], required: [] });
  assert.deepEqual(classifyAppAccesses('open the Notes app and read the latest in Spotify'),
    { explicit: ['notes'], required: ['spotify'] });
});

test('comprehension audit: a question about what CHE can do is not a purchase; a named one still is', () => {
  for (const ask of ['Can you buy things for me?', 'Could you pay my bills if I asked?', 'can you buy stuff online', 'Can you delete things?',
    'could you pay my rent if i asked you to', 'Can you order something for me', 'can you delete my emails if i asked']) {
    assert.deepEqual(classifyOwnerActions(ask), [], ask);
  }
  for (const ask of ['Can you buy me a coffee?', 'Could you pay my electric bill?', 'Can you buy things for me? Buy me a coffee.',
    'Can you buy anything for me right now, like a coffee?', 'Can you order me something', 'Pay my rent if I asked you to yesterday']) {
    assert.deepEqual(classifyOwnerActions(ask), ['money'], ask);
  }
});

test('comprehension audit: an app CHE studies or reports on is not an app she uses', () => {
  for (const text of ['How many subscribers do I have on YouTube?', 'Run your REA on the Notion app.', 'Investigate the Notion app',
    "If I asked you to run REA on Spotify, what would happen? Don't run it.", 'How much watch time do I have on YouTube?']) {
    assert.deepEqual(classifyAppAccesses(text), { explicit: [], required: [] }, text);
  }
  // Opening, playing, posting or reading inside the app still needs the owner's permission.
  for (const [text, app] of [['Read my last note in Notes.', 'notes'], ["what's on spotify", 'spotify'], ['play my liked songs on Spotify', 'spotify'],
    ['watch my latest videos on YouTube', 'youtube'], ['post this on youtube', 'youtube'], ['analyze my notes in Notes', 'notes'], ['check my comments on youtube', 'youtube']]) {
    assert.deepEqual(classifyAppAccesses(text).required, [app], text);
  }
});

test('"reset my progress" is a delete; a progress bar, a report, a call or a game score is not (Knowledge Atlas #346)', () => {
  for (const s of ['reset my progress', 'Reset my progress.', 'reset my learning progress', 'CHE, clear my trading quiz scores', 'clear my quiz scores', 'reset my atlas progress', 'delete my knowledge atlas progress']) {
    assert.deepEqual(classifyOwnerActions(s), ['delete'], s);
  }
  for (const s of [
    'clear the progress bar when the upload finishes', 'reset the progress spinner after each request', 'drop the progress indicator from the home screen',
    'reset the score to zero when the game restarts', 'drop scores below 50 from the chart', 'clear the scores on the leaderboard widget',
    'cancel the progress report', 'cancel my progress call with Mark', 'reset my progress bar', 'reset my thoughts', 'clear the screen',
  ]) {
    assert.deepEqual(classifyOwnerActions(s), [], s);
  }
});

// Comprehension audit, review of PR #356 (issue #350): sign-up is held like a purchase, selling moves money, Robinhood
// is an app, and the ordinary requests the audit keeps stay as they were.
test('review #356: sign-up phrasings are held for the owner\'s yes, and REA investigation of an app does not sign up', async () => {
  assert.deepEqual(classifyOwnerActions('Investigate the Notion app and sign me up'), ['signup']);
  assert.deepEqual(classifyOwnerActions('sign me up'), ['signup']);
  assert.deepEqual(classifyOwnerActions('create an account on Notion'), ['signup']);
  assert.deepEqual(classifyOwnerActions('create a Notion account'), ['signup']);
  assert.deepEqual(classifyOwnerActions('register me with Notion'), ['signup']);
  assert.deepEqual(classifyOwnerActions('set up a Notion account'), ['signup']);
  assert.deepEqual(classifyOwnerActions('set up an account on Notion'), ['signup']);
  const gate = gateOwnerAction('Investigate the Notion app and sign me up', {});
  assert.equal(gate.allowed, false);
  assert.equal(gate.kind, 'signup');
  assert.match(gate.ask, /sign you up for anything/);
  assert.equal(gateOwnerAction('Investigate the Notion app and sign me up', { signup: true }).allowed, true);
  assert.equal(peerActionReply('sign me up for Notion').includes('signed up'), true);
  // REA reads the app's listing: naming it is not using it, and no sign-up is asked for.
  assert.deepEqual(classifyOwnerActions('Investigate the Notion app and tell me how it works'), []);
  assert.deepEqual(classifyAppAccesses('Investigate the Notion app and tell me how it works'), { explicit: [], required: [] });
  assert.deepEqual(classifyOwnerActions('do not sign me up for anything'), []);
});

test('review #356: "sell" is a money verb and Robinhood is an app', () => {
  assert.equal(classifyOwnerAction('sell my Tesla shares'), 'money');
  assert.deepEqual(classifyOwnerActions('can you open Robinhood and sell my Tesla shares'), ['money']);
  assert.deepEqual(classifyAppAccesses('can you open Robinhood and sell my Tesla shares'), { explicit: ['robinhood'], required: [] });
  assert.match(gateOwnerAction('can you open Robinhood and sell my Tesla shares').ask, /spend, buy or sell anything/);
  assert.match(gateOwnerAction('buy the domain chey-test.com').ask, /spend or buy anything/);
  // Questions about selling, and CHE's ability to sell, ask for nothing.
  assert.deepEqual(classifyOwnerActions('what is the best time to sell'), []);
  assert.deepEqual(classifyOwnerActions('can you sell things for me?'), []);
});

test('review #356: the requests the audit keeps are unchanged', () => {
  assert.deepEqual(classifyOwnerActions('can you buy things for me?'), []);
  assert.equal(classifyOwnerAction('buy me a coffee'), 'money');
  assert.equal(classifyOwnerAction('can you delete my old emails'), 'delete');
  assert.equal(classifyOwnerAction('CHE, forget that my favorite color is blue'), 'delete');
  assert.deepEqual(classifyOwnerActions("don't forget to buy milk"), []);
  assert.equal(classifyAppNeed('read my last note in Notes'), 'notes');
});

// Review of PR #356, blocker 2: ordinary sentences with "sell", "sales", "set up" or "register" are not held. Money and
// deletion are the only things asked first, and a sign-up only when it names a service.
// Review of PR #356, round 2: a bare "sell" is a sale and is held; these idioms and figures are not.
test('review #356: ordinary talk with sell, sales or set up is not held', () => {
  assert.deepEqual(classifyOwnerActions('sell me on this idea'), []);
  assert.deepEqual(classifyOwnerActions('how many sales did I make, sell-through?'), []);
  assert.deepEqual(classifyOwnerActions('sell the idea to Ann'), []);
  assert.deepEqual(classifyOwnerActions('set up my account on the phone'), []);
  assert.deepEqual(classifyOwnerActions('how do I set up my printer'), []);
  assert.deepEqual(classifyOwnerActions('can you sell things for me?'), []);
});

test('review #356: every bare sale is held, including "sell MNQ", and the wording names selling', () => {
  for (const s of ['sell Tesla', 'sell shares', 'sell everything', 'sell bitcoin now', 'sell $500 of Tesla', 'sell out of my position', 'sell off my shares', 'sell MNQ', 'sell it for $500', 'sell the car']) {
    assert.equal(classifyOwnerAction(s), 'money', s);
  }
  assert.deepEqual(classifyOwnerActions('sell me on this idea and sell my shares'), ['money']);
  assert.match(gateOwnerAction('sell MNQ').ask, /spend, buy or sell anything/);
});

// Review of PR #356, round 2: a registration or a new account is one yes, sign-up or money. "Set up my account" names an
// account the owner already has, so it is not held.
test('review #356: registrations and new accounts are held for the owner\'s yes', () => {
  for (const s of ['register me for the course', 'register me for the newsletter', 'register me with Notion', 'set up an account on Etsy',
    'set up a Notion account', 'create an account on Etsy', 'make me an account on Steam', 'sign me up for Notion', 'create an account on Notion']) {
    assert.deepEqual(classifyOwnerActions(s), ['signup'], s);
  }
  assert.deepEqual(classifyOwnerActions('set up my account on the phone'), []);
});

// The money and delete holds the owner's rules keep, unchanged by these fixes (the reviewer's lists).
test('review #356: the money and delete holds the owner rules keep are unchanged', () => {
  for (const s of ['buy me a coffee', 'pay the electric bill', 'order pizza', 'subscribe to Netflix', 'transfer $50 to Ann', 'top up my phone',
    'renew my domain', 'upgrade to pro', 'donate to the food bank', 'buy 2 AirPods', 'send $20 to Mark', 'sign up for the gym']) {
    assert.deepEqual(classifyOwnerActions(s), ['money'], s);
  }
  for (const s of ['delete my old emails', 'remove my notes about Ann', 'clear my memory', 'forget that my favorite color is blue',
    'erase the chat history', 'reset my notes']) {
    assert.deepEqual(classifyOwnerActions(s), ['delete'], s);
  }
});
