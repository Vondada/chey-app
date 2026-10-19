// What the owner says about Gmail, Drive, Calendar and YouTube is understood
// deterministically: the wake word, polite leads, speech variants and follow-ups
// on the last list. Ordinary sentences must not become Google requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { googleChatIntent, normalizeGoogleRequest, youtubeChatIntent } from './google_services.js';

test('the owner\'s mandatory Gmail, Calendar, Drive and YouTube phrases are recognised', () => {
  assert.deepEqual(googleChatIntent('CHE, check my unread emails and tell me the newest one.'), { kind: 'gmail_list', pick: 'newest' });
  assert.deepEqual(googleChatIntent('Check my email.'), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('Do I have any new emails?'), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('Read my latest unread email.'), { kind: 'gmail_read', pick: 'newest' });
  assert.deepEqual(googleChatIntent('CHE, what’s on my calendar today?'), { kind: 'calendar_list', range: 'today' });
  assert.deepEqual(googleChatIntent("What's on my schedule tomorrow?"), { kind: 'calendar_list', range: 'tomorrow' });
  assert.deepEqual(googleChatIntent('CHE, list my Google Drive files.'), { kind: 'drive_list' });
  assert.deepEqual(
    googleChatIntent('Create a Google Doc called Test Plan with the words Connection Verified.'),
    { kind: 'drive_create', name: 'Test Plan', text: 'Connection Verified' },
  );
  assert.equal(youtubeChatIntent('CHE, check my YouTube channel.'), true);
});

test('speech variants keep the same meaning: wake words, polite leads, punctuation and spacing', () => {
  assert.deepEqual(googleChatIntent('Chay, check my e-mails'), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('Hey CHE, can you check my email please?'), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('chey could you list my unread emails'), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('CHE check my e mail'), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('  CHE,   check   my   emails  '), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('CHE, read my latest unread e-mail'), { kind: 'gmail_read', pick: 'newest' });
  assert.equal(normalizeGoogleRequest('Hey Chay, please check my inbox, thanks!'), 'check my inbox');
  assert.equal(normalizeGoogleRequest('CHE: what’s on my calendar tomorrow.'), 'what\'s on my calendar tomorrow');
});

test('names and words the owner said are kept as spoken', () => {
  assert.deepEqual(googleChatIntent('Create a Google Doc called Test Plan with the words "Connection Verified".'),
    { kind: 'drive_create', name: 'Test Plan', text: 'Connection Verified' });
  assert.deepEqual(googleChatIntent('send an email to ann@example.com saying lunch at noon'),
    { kind: 'gmail_send', to: 'ann@example.com', body: 'lunch at noon' });
});

test('an email request that names the newest one is a list with the newest picked', () => {
  assert.deepEqual(googleChatIntent("what's the newest email"), { kind: 'gmail_list', pick: 'newest' });
  assert.deepEqual(googleChatIntent('check my unread emails and tell me the latest one'), { kind: 'gmail_list', pick: 'newest' });
  assert.deepEqual(googleChatIntent('how many unread emails do I have'), { kind: 'gmail_list' });
});

test('follow-ups resolve only against the list the owner just heard', () => {
  const gmail = { service: 'gmail', messages: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(googleChatIntent('read the newest one', { last: gmail }), { kind: 'gmail_read', index: 0 });
  assert.deepEqual(googleChatIntent('read number two', { last: gmail }), { kind: 'gmail_read', index: 1 });
  assert.deepEqual(googleChatIntent('CHE, open the second one.', { last: gmail }), { kind: 'gmail_read', index: 1 });
  assert.equal(googleChatIntent('read the newest one'), null, 'no list heard yet: not a Google request');
  assert.equal(googleChatIntent('read the newest one', { last: { service: 'calendar' } }), null);

  const calendar = { service: 'calendar', range: 'today' };
  assert.deepEqual(googleChatIntent('what about tomorrow', { last: calendar }), { kind: 'calendar_list', range: 'tomorrow' });
  assert.deepEqual(googleChatIntent('and this week?', { last: calendar }), { kind: 'calendar_list', range: 'this week' });
  assert.equal(googleChatIntent('what about tomorrow'), null, 'no calendar heard yet');

  const drive = { service: 'drive' };
  assert.deepEqual(googleChatIntent('show me those files', { last: drive }), { kind: 'drive_list' });
  assert.equal(googleChatIntent('show me those files'), null);
});

test('requests Google cannot do yet are named, not left to a model that cannot see the account', () => {
  assert.deepEqual(googleChatIntent('check my email from Bob'), { kind: 'gmail_unsupported' });
  assert.deepEqual(googleChatIntent("what's on my calendar on Friday"), { kind: 'calendar_unsupported' });
  assert.deepEqual(googleChatIntent('create a doc called Plan'), { kind: 'drive_incomplete' });
  assert.deepEqual(googleChatIntent('send an email to ann@example.com'), { kind: 'gmail_incomplete' });
});

test('ordinary conversation never becomes a Google request', () => {
  const ordinary = [
    'I checked my email yesterday and it was fine.',
    "What's the email address format for Bob?",
    'Show me the calendar of the French revolution.',
    'Read my latest blog post.',
    'Do I have any ideas for dinner?',
    'Check my youtube video about cats',
    'Create a spreadsheet called budget',
    'Send the photo to my mom',
    'I want to check my email tomorrow',
    'Please tell me about the email I sent yesterday',
    'Can you explain what a calendar is?',
    'Read my notes about the trip',
    'Why did the build fail?',
    'open my mail app',
    'open my email settings',
  ];
  for (const message of ordinary) {
    assert.equal(googleChatIntent(message), null, message);
    assert.equal(youtubeChatIntent(message), false, message);
  }
});

test('YouTube channel questions are recognised, and nothing else is', () => {
  assert.equal(youtubeChatIntent('check my YouTube channel'), true);
  assert.equal(youtubeChatIntent("what's my YouTube channel?"), true);
  assert.equal(youtubeChatIntent('CHE, show my channel status'), true);
  assert.equal(youtubeChatIntent('is my YouTube connected?'), true);
  assert.equal(youtubeChatIntent('check my youtube video about cats'), false);
});

// Near-miss phrasings used to fall to a model that cannot see the account, or
// were answered with the wrong refusal ("check my calendar for tomorrow" was
// told to name tomorrow; "email ann@… saying hi" was told to give an address).
test('everyday Drive, Calendar and Gmail wordings reach the real integration', () => {
  assert.deepEqual(googleChatIntent('CHE, list my recent Drive files'), { kind: 'drive_list' });
  assert.deepEqual(googleChatIntent('what files are in my Google Drive?'), { kind: 'drive_list' });
  assert.deepEqual(googleChatIntent('check my calendar for tomorrow'), { kind: 'calendar_list', range: 'tomorrow' });
  assert.deepEqual(googleChatIntent('What meetings do I have today?'), { kind: 'calendar_list', range: 'today' });
  assert.deepEqual(googleChatIntent('what events have I got this week'), { kind: 'calendar_list', range: 'this week' });
  assert.deepEqual(googleChatIntent('email ann@example.com saying I will be late'), { kind: 'gmail_send', to: 'ann@example.com', body: 'I will be late' });
  assert.deepEqual(googleChatIntent('email the team saying hi'), { kind: 'gmail_incomplete' }, 'no address: nothing is guessed');
  // "latest email" is the newest in the inbox; only "unread" or "new" narrows it.
  assert.deepEqual(googleChatIntent('read my latest email'), { kind: 'gmail_read', pick: 'newest', scope: 'inbox' });
  assert.deepEqual(googleChatIntent('read my newest unread email'), { kind: 'gmail_read', pick: 'newest' });
});

test('comprehension audit: spoken calendar questions, sender questions, natural event adds and Drive search have their own honest answers', () => {
  assert.deepEqual(googleChatIntent('whats on my calendar today'), { kind: 'calendar_list', range: 'today' });
  assert.deepEqual(googleChatIntent('Do I have anything on my calendar Friday?'), { kind: 'calendar_unsupported' });
  for (const text of ['Do I have any new emails from Sarah?', "Don't send anything, just tell me if Sarah emailed me today.", 'did bob email me']) {
    assert.deepEqual(googleChatIntent(text), { kind: 'gmail_unsupported' }, text);
  }
  for (const text of ['Add a meeting with Bob tomorrow at 3pm to my calendar.', 'Put dinner with Maria on my calendar Friday at 7.']) {
    assert.deepEqual(googleChatIntent(text), { kind: 'calendar_incomplete' }, text);
  }
  assert.equal(googleChatIntent('add Dentist on 2026-10-21 at 15:00')?.kind, 'calendar_create');
  for (const text of ['Find the budget spreadsheet in my Drive.', 'search my drive for the tax return']) {
    assert.deepEqual(googleChatIntent(text), { kind: 'drive_unsupported' }, text);
  }
  assert.deepEqual(googleChatIntent('Read my last email out loud.'), { kind: 'gmail_read', pick: 'newest', scope: 'inbox' });
  // "Can you send emails for me?" asks what CHE can do; a send the owner forbade is not a send, and his
  // "don't send it" never becomes the email's last line.
  assert.equal(googleChatIntent('Can you send emails for me?'), null);
  assert.equal(googleChatIntent("Email bob@example.com saying the invoice is ready, but don't send it yet."), null);
  assert.deepEqual(googleChatIntent("email bob@example.com saying please don't send the invoice twice"),
    { kind: 'gmail_send', to: 'bob@example.com', body: "please don't send the invoice twice" });
  for (const text of ['What are my latest YouTube videos?', 'How many subscribers do I have on YouTube?', 'how is my youtube channel doing', 'Did the moon video upload?']) {
    assert.equal(youtubeChatIntent(text), true, text);
  }
  assert.equal(youtubeChatIntent('what are the latest videos about cats'), false);
});
