// CHE Command Center: one catalog of owner commands over CHE's EXISTING
// runtime. A command is a stable name for something CHE can already do (or
// honestly cannot do yet): it never adds a second router, planner or agent.
//
// Running a command means sending its request through the ordinary /api/chat
// pipeline, so every owner gate (money, delete, apps), every truth guard and
// every receipt applies exactly as if the owner had said the words. A
// workflow runs its steps as nodes of CHE's existing objective graph and job
// queue (objective_graph.js), with the same retries, checkpoints and recovery.
//
// Everything in this module is deterministic: lookup, search, availability,
// suggestions and workflow validation never call a model.

export const CATEGORIES = Object.freeze([
  { id: 'intelligence', title: 'Intelligence & Control', summary: 'Think, research, verify, remember and recover.' },
  { id: 'youtube', title: 'YouTube', summary: 'Research, script, render and publish faceless videos.' },
  { id: 'trading', title: 'Trading', summary: 'NQ/MNQ market reads, risk, backtests and the trading desk.' },
  { id: 'build', title: 'Websites, Apps & AI', summary: 'Build and fix sites, apps, AI tools and CHE herself.' },
  { id: 'money', title: 'Money Management', summary: 'Budgets, cash flow, invoices, pricing and profit.' },
  { id: 'clients', title: 'Client Scouting & Delivery', summary: 'Find lawful leads, propose, follow up and deliver.' },
  { id: 'marketing', title: 'Marketing & Sales', summary: 'Brand, campaigns, content, ads and funnels.' },
  { id: 'office', title: 'Office & Automation', summary: 'The Office crew, integrations, skills and voice.' },
  { id: 'studio', title: 'Creator Studio', summary: 'An original series: bible, pilot, render, export and posting.' },
]);

// What a command may need. `kind` says how it becomes ready:
//   builtin  always part of CHE
//   secret   a Worker secret the owner adds in Keys
//   oauth    the owner signs in on the provider's own page
//   none     CHE has no connector for this yet (the command is unsupported)
export const CONNECTORS = Object.freeze({
  model: { label: 'CHE language engine', kind: 'builtin', setup: 'An AI engine must be reachable. Say "check my keys" to hear which engines answer.' },
  research: { label: 'Public web research', kind: 'builtin', setup: 'Built in. Needs internet access.' },
  market_data: { label: 'Public market data (Stooq/Binance)', kind: 'builtin', setup: 'Built in. Owner data feed optional: CHE_MARKET_DATA_URL.' },
  office: { label: 'Office crew', kind: 'builtin', setup: 'Built in.' },
  memory: { label: 'Owner memory and receipts', kind: 'builtin', setup: 'Built in.' },
  jobs: { label: 'Background jobs and missions', kind: 'builtin', setup: 'Built in.' },
  site_hosting: { label: 'CHE site hosting', kind: 'builtin', setup: 'Built in: CHE serves the sites she builds.' },
  broker: { label: 'NinjaTrader / Tradovate account', kind: 'oauth', setup: 'Add CHE_TRADOVATE_OAUTH_CLIENT_ID and CHE_TRADOVATE_OAUTH_CLIENT_SECRET, then say "connect NinjaTrader" and sign in on Tradovate\'s page.' },
  youtube: { label: 'YouTube channel', kind: 'oauth', setup: 'Open Mailbox → Keys → YouTube and sign in with Google.' },
  gmail: { label: 'Gmail', kind: 'oauth', setup: 'Say "connect my Gmail" or open Connections, then approve Gmail on Google\'s page.' },
  drive: { label: 'Google Drive', kind: 'oauth', setup: 'Say "connect Google Drive" or open Connections, then approve Drive on Google\'s page. CHE sees only files it creates or you open with it.' },
  calendar: { label: 'Google Calendar', kind: 'oauth', setup: 'Say "connect my calendar" or open Connections, then approve Calendar on Google\'s page.' },
  google_ads: { label: 'Google Ads', kind: 'oauth', setup: 'Say "connect Google Ads" or open Connections. Also needs CHE_GOOGLE_ADS_DEVELOPER_TOKEN from Google Ads API approval.' },
  video_renderer: { label: 'Video renderer', kind: 'secret', setup: 'Needs CHE_VIDEO_RENDER_URL, or CHE_GITHUB_TOKEN with CHE_GITHUB_REPO for the free GitHub renderer.' },
  image_generation: { label: 'Image generation', kind: 'secret', setup: 'Workers AI images are built in when the AI binding is on; HD providers need their key and the paid-media switch.' },
  voice: { label: 'CHE voice (ElevenLabs or Fish)', kind: 'secret', setup: 'Add ELEVENLABS_API_KEY (or FISH_API_KEY) as a Worker secret.' },
  github: { label: 'GitHub connection', kind: 'secret', setup: 'Add CHE_GITHUB_TOKEN and CHE_GITHUB_REPO as Worker secrets.' },
  repo: { label: 'CHE repository name', kind: 'secret', setup: 'Add CHE_GITHUB_REPO (owner/name of CHE\'s own repository) as a Worker setting. Its public tree can be read without a token.' },
  stripe: { label: 'Stripe', kind: 'secret', setup: 'Add STRIPE_SECRET_KEY (or CHE_PAYMENTS_URL) as a Worker secret.' },
  sms: { label: 'Twilio SMS', kind: 'secret', setup: 'Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a sender number as Worker secrets.' },
  bookkeeping: { label: 'Bank or bookkeeping feed', kind: 'none', setup: 'CHE has no bank or bookkeeping connector yet.' },
  ads_account: { label: 'Ad account (Google/Meta)', kind: 'none', setup: 'CHE has no ad-platform connector yet.' },
  fundyouredge: { label: 'FundYourEdge funded account (Rithmic)', kind: 'none', setup: 'Rithmic requires its own licensed API before CHE can read or trade a funded account. Nothing is connected.' },
});

export const MODES = Object.freeze({ EXPLORE: 'EXPLORE', PLAN: 'PLAN', BUILD: 'BUILD' });

// Guardrail wording that rides along with model-answered commands only. It is
// part of the selected command's request, so nothing is added to other turns.
const NUMBERS_RULE = 'Use only figures I give you or that a connected record returns; label every estimate as an estimate and never invent a number.';
// Worded so CHE's own money/delete gate (owner_action_gate.js) never reads
// the guardrail itself as a request to buy or delete.
const PLAN_RULE = 'Plan only. Take no actions; this is a written plan.';

// One entry per command. Fields:
//   mode      EXPLORE (read-only), PLAN (no side effects), BUILD (acts)
//   confirm   why the owner must approve first ('' = no extra approval)
//   needs     connectors that must be ready; optional = used when present
//   route     the done.source the request reaches today ('model' = CHE's
//             language engine answers with the command's instructions)
//   handler   the existing module/function that does the work
//   prompt    the request sent through /api/chat; {input} is the owner's text
//   produces  what a later workflow step can use
//   evidence  what the result must carry before CHE may call it done
const C = (id, category, mode, summary, extra) => Object.freeze({
  id, category, mode, summary,
  title: extra.title || id.replace(/^\w|-\w/g, (s) => s.replace('-', ' ').toUpperCase()),
  does: extra.does,
  confirm: extra.confirm || '',
  needs: Object.freeze(extra.needs || ['model']),
  optional: Object.freeze(extra.optional || []),
  input: extra.input === null ? null : Object.freeze(extra.input || { name: 'request', required: false, hint: 'What you want' }),
  examples: Object.freeze(extra.examples || []),
  route: extra.route || 'model',
  handler: extra.handler || 'ai_router (language engine)',
  prompt: extra.prompt,
  local: extra.local || '',
  produces: extra.produces || 'notes',
  evidence: extra.evidence || 'Facts carry their source; anything else is labeled as opinion or estimate.',
  cost: extra.cost || 'Free engines only, unless you turned paid AI on.',
  keywords: Object.freeze(extra.keywords || []),
  aliases: Object.freeze(extra.aliases || []),
});

export const COMMANDS = Object.freeze([
  // ── Intelligence & Control ────────────────────────────────────────────
  C('che', 'intelligence', 'EXPLORE', 'Main assistant and skill coordinator.', {
    title: 'CHE', does: 'Answers or acts on anything you ask, choosing the right CHE skill herself.',
    input: { name: 'request', required: true, hint: 'Anything you want CHE to do' },
    examples: ['CHE, help me plan my week', 'CHE, what can you do for my business?'],
    prompt: '{input}', keywords: ['assistant', 'help', 'anything'],
  }),
  C('che-explore', 'intelligence', 'EXPLORE', 'Read-only exploration.', {
    does: 'Looks into a question or CHE\'s own code and reports what exists. Changes nothing.',
    needs: ['model', 'github'], route: 'che_repository_inspection', handler: 'code_scout.repositoryInspectionIntent → inspectReferenceRepo',
    input: { name: 'topic', required: true, hint: 'What to look into' },
    examples: ['Explore how the trading desk decides entries', 'Read-only: where does CHE store my memories?'],
    prompt: 'Inspect your codebase and explain how {input} works, with file paths. Read-only, change nothing.',
    produces: 'findings', evidence: 'File paths and lines from the current repository commit.', keywords: ['investigate', 'inspect', 'look into', 'read only', 'code'],
  }),
  C('che-plan', 'intelligence', 'PLAN', 'Create plans without execution.', {
    does: 'Writes a step-by-step plan with risks and checkpoints. Nothing is executed.',
    input: { name: 'goal', required: true, hint: 'What you want to achieve' },
    examples: ['Plan a booking app for my barbershop', 'Make a plan to launch my YouTube channel'],
    prompt: `Plan only, do not build or execute anything. ${PLAN_RULE} Write a numbered plan for: {input}. Include goal, steps with the order they must happen in, what each step needs, risks, and where my approval is needed.`,
    produces: 'plan', keywords: ['plan', 'roadmap', 'steps', 'strategy', 'how should i'],
  }),
  C('che-build', 'intelligence', 'BUILD', 'Authorized implementation.', {
    does: 'Starts a reviewed coding job on CHE\'s own code: a draft pull request, tests and review. Merging and deploying need your separate yes.',
    needs: ['model', 'github'], route: 'che_self_development', handler: 'self_development.js (draft PR pipeline)',
    input: { name: 'change', required: true, hint: 'The change to make in CHE' },
    examples: ['Build a dark mode switch for the Office screen', 'Implement voice search in Mailbox'],
    prompt: 'Change your code: implement {input}. Open a draft pull request with tests.',
    produces: 'pull request', evidence: 'Pull request number, CI result and review outcome.', keywords: ['implement', 'build', 'code', 'change che', 'feature'],
  }),
  C('che-research', 'intelligence', 'EXPLORE', 'Research actual information.', {
    does: 'Searches public sources and answers with what it actually found and where.',
    needs: ['model', 'research'], route: 'model', handler: 'public research (Wikipedia, DuckDuckGo) + research cache',
    input: { name: 'question', required: true, hint: 'What to research' },
    examples: ['Research the best cities for barbershops', 'Research how long faceless channels take to monetize'],
    prompt: 'Research {input} using real sources and tell me only what you verified, with the sources.',
    produces: 'research', evidence: 'Every fact names the source CHE actually read.', keywords: ['research', 'find out', 'look up', 'sources', 'search'],
  }),
  C('che-verify', 'intelligence', 'EXPLORE', 'Verify facts and evidence.', {
    does: 'Fact-checks a claim against sources, or explains the evidence behind one of CHE\'s answers.',
    needs: ['model', 'research'], route: 'model', handler: 'truth_layer.js + memory_provenance.js receipts',
    input: { name: 'claim', required: true, hint: 'The claim or answer to check' },
    examples: ['Verify that NQ opens at 9:30 New York time', 'How do you know that is correct?'],
    prompt: 'Fact-check this and tell me what is verified, what is not, and the sources: {input}',
    produces: 'verdict', evidence: 'A verdict per claim with the source or receipt behind it.', keywords: ['verify', 'fact check', 'true', 'evidence', 'how do you know', 'proof'],
  }),
  C('che-memory', 'intelligence', 'EXPLORE', 'Retrieve and reconcile confirmed knowledge.', {
    does: 'Answers only from what you told or confirmed to CHE, and says plainly when there is no record.',
    needs: ['memory'], route: 'che_memory_provenance', handler: 'memory_provenance.answerOwnerMemoryQuestion',
    input: { name: 'question', required: true, hint: 'What to recall' },
    examples: ['What do you remember about my business?', 'What have I confirmed about my trading rules?'],
    prompt: 'What have I told you about {input}?',
    produces: 'memories', evidence: 'Only owner-attested records; zero model calls.', keywords: ['remember', 'memory', 'recall', 'what did i say', 'confirmed'],
  }),
  C('che-brain-review', 'intelligence', 'EXPLORE', 'Hear the morning Brain review.', {
    does: 'Reads the latest daily review computed from your Brain’s own records: facts, inferences with their rules, hypotheses marked as such, recommendations, one interpretation, and what is unknown. Says so when there is none yet.',
    needs: ['memory'], route: 'che_brain_review', handler: 'brain_audit.brainReviewIntent → latestReview → speakReview',
    input: null,
    examples: ['Read me my brain review', 'What did your audit find this morning?'],
    prompt: 'Read me my brain review',
    produces: 'review', evidence: 'Every line comes from the stored review record, computed from Brain records; zero model calls.', keywords: ['brain review', 'morning review', 'daily review', 'audit', 'conclusions'],
  }),
  C('che-recover', 'intelligence', 'BUILD', 'Recover interrupted or failed tasks.', {
    does: 'Resumes the saved coding job or mission step from its checkpoint instead of starting over.',
    needs: ['jobs'], route: 'che_coding_resume', handler: 'recovery_policy.js + objective_graph.recoverNode',
    input: null,
    examples: ['Resume the coding job', 'Recover the failed mission step'],
    prompt: 'Resume the coding job',
    produces: 'status', evidence: 'The job id and the checkpoint it resumed from.', keywords: ['recover', 'resume', 'retry', 'failed', 'interrupted', 'stuck'],
  }),
  // Owner, 2026-10-19 ("Cancel that fake commit by Che"): the voice and typed route to the
  // owner-only POST /api/job/cancel. Cancelling a queued job deletes nothing, so it asks nothing first.
  C('che-cancel-job', 'intelligence', 'BUILD', 'Cancel a coding job that has not started.', {
    does: 'Cancels a queued coding job: by its id, or the one CHE last accepted. A running, finished or failed job is left alone and CHE says so. The job record is kept, marked cancelled with who cancelled it and when. Nothing is deleted.',
    needs: ['jobs'], route: 'che_coding_cancel', local: 'coding_cancel', handler: 'coding_cancel.cancelQueuedJob (shared with POST /api/job/cancel)',
    input: { name: 'job', required: false, hint: 'A coding job id, or leave it empty for the job CHE last accepted' },
    examples: ['Cancel coding job c2987a73', 'Cancel that coding job', 'Cancel the last coding job'],
    // Not dispatched (the command runs locally); worded so the money/delete gate never reads it as a delete.
    prompt: 'Stop queued coding job {input}',
    produces: 'status', evidence: 'The job record read back after the change: its id and status.',
    cost: 'Free: no AI engine is used.', keywords: ['cancel', 'cancel job', 'coding job', 'fake commit', 'call off', 'abort'],
  }),
  C('che-status', 'intelligence', 'EXPLORE', 'Report verified progress and outcomes.', {
    does: 'Reports what is actually running, finished or failed, from CHE\'s own records.',
    needs: ['jobs'], route: 'che_mission_status', handler: 'objective_graph.speakObjective',
    input: null,
    examples: ['Mission status', 'How are my missions going?'],
    prompt: 'Mission status', produces: 'status', evidence: 'Job and mission records only.', keywords: ['status', 'progress', 'what is running', 'done', 'mission'],
  }),
  C('learn', 'intelligence', 'EXPLORE', 'Learn coding and trading, beginner to expert.', {
    title: 'Knowledge Atlas',
    does: 'Teaches a coding or trading concept from CHE\'s Knowledge Atlas cards: a beginner, intermediate or expert explanation, an analogy, the exact formula, a tested worked example and a short quiz. Trading figures come only from your recorded paper journal and stored backtest. A topic with no card is said plainly, never made up.',
    needs: [], route: 'che_knowledge_atlas', handler: 'knowledge_atlas.atlasIntent → answerAtlas',
    input: { name: 'topic', required: false, hint: 'A concept or a request, like recursion or quiz me on expectancy' },
    examples: ['Teach me recursion', 'Explain expectancy like I\'m a beginner', 'What\'s the formula for VWAP?', 'Quiz me on risk management', 'List the trading cards'],
    prompt: 'Knowledge Atlas: {input}', produces: 'lesson',
    evidence: 'The card and revision it came from; trading figures only from journal or backtest records; zero model calls.',
    cost: 'Free: no AI engine is used.', keywords: ['learn', 'lesson', 'teach me', 'explain', 'formula', 'quiz', 'concept', 'beginner', 'expert', 'atlas'],
  }),

  // ── YouTube ───────────────────────────────────────────────────────────
  C('yt-ideas', 'youtube', 'EXPLORE', 'Research promising video ideas.', {
    does: 'Finds topic ideas from real public sources and explains why each could work. Never invents demand numbers.',
    needs: ['model', 'research'], handler: 'public research + topic_scout.js (CHE_TREND_URLS feeds)',
    input: { name: 'niche', required: true, hint: 'Channel niche' },
    examples: ['Video ideas for a faceless history channel', 'Find trending ideas about space'],
    prompt: `Research faceless YouTube video ideas about {input}. Give 5 ideas, each with the real source that shows interest in it. ${NUMBERS_RULE}`,
    produces: 'video ideas', keywords: ['video ideas', 'youtube ideas', 'topics', 'faceless', 'channel'],
  }),
  C('yt-research', 'youtube', 'EXPLORE', 'Gather and verify information.', {
    does: 'Collects facts for a video topic with sources, ready for a script.',
    needs: ['model', 'research'], handler: 'public research + research cache',
    input: { name: 'topic', required: true, hint: 'Video topic' },
    examples: ['Research octopus intelligence for a video', 'Gather facts about the pyramids for my script'],
    prompt: 'Research {input} for a YouTube video using real sources and tell me only what you verified, with the sources.',
    produces: 'sourced facts', evidence: 'Every fact names its source.', keywords: ['video research', 'facts', 'sources'],
  }),
  C('yt-script', 'youtube', 'PLAN', 'Create original video scripts.', {
    does: 'Writes an original narration script with a hook, beats and a closing, citing the researched facts it uses.',
    input: { name: 'topic', required: true, hint: 'Topic or angle' },
    examples: ['Write a 60 second script about octopus intelligence', 'Script a Short about black holes'],
    prompt: `Write an original faceless YouTube narration script about {input}: hook, 4-6 beats, closing line, about 150 words per minute. Mark which lines rely on sourced facts. ${PLAN_RULE}`,
    produces: 'script', keywords: ['script', 'narration', 'video script', 'short'],
  }),
  C('yt-video', 'youtube', 'BUILD', 'Generate and assemble videos.', {
    does: 'Renders a faceless video (script, scenes, narration) on CHE\'s video line. An mp4 exists only if the renderer returns one.',
    needs: ['model', 'video_renderer'], route: 'video_renderer', handler: 'faceless_video.js → github_video_renderer.js / moneyprinter.js',
    input: { name: 'topic', required: true, hint: 'Video topic' },
    examples: ['Make a faceless video about octopus intelligence', 'Render a 30 second video about Mars'],
    prompt: 'Make a faceless video about {input}',
    produces: 'video', evidence: 'A verified mp4 link from the renderer, or the exact render error.', cost: 'Free renderer on GitHub Actions; paid video engines stay off unless you enable them.', keywords: ['make a video', 'render', 'video'],
  }),
  C('yt-voice', 'youtube', 'BUILD', 'Create audio narration.', {
    does: 'Narration is produced inside the video line in CHE\'s voice (ElevenLabs, then Fish). A standalone audio file is not offered yet.',
    needs: ['model', 'voice', 'video_renderer'], route: 'video_renderer', handler: 'tools/che_video_render.py narration (Fish/ElevenLabs/Piper)',
    input: { name: 'topic', required: true, hint: 'Video topic' },
    examples: ['Narrate a video about the ocean'],
    prompt: 'Make a faceless video about {input}',
    produces: 'narrated video', cost: 'Uses your ElevenLabs/Fish credits.', keywords: ['narration', 'voiceover', 'voice over', 'audio'],
  }),
  C('yt-thumbnail', 'youtube', 'BUILD', 'Generate thumbnails.', {
    does: 'Generates a thumbnail image from your description with CHE\'s image engine.',
    needs: ['image_generation'], route: 'model', handler: 'media.js image generation',
    input: { name: 'description', required: true, hint: 'What the thumbnail shows' },
    examples: ['Generate a thumbnail image of a glowing octopus brain'],
    prompt: 'Generate an image for a YouTube thumbnail: {input}. Bold, high contrast, at most 4 words of text.',
    produces: 'image', evidence: 'The generated image link.', keywords: ['thumbnail', 'cover image'],
  }),
  C('yt-seo', 'youtube', 'PLAN', 'Optimize titles, descriptions, and metadata.', {
    does: 'Drafts titles (under 100 characters), a description and tags that match the script, without clickbait claims.',
    input: { name: 'video', required: true, hint: 'Video topic or script' },
    examples: ['SEO title and tags for my octopus video'],
    prompt: `Write YouTube metadata for this video: 3 title options under 70 characters, a description under 500 characters that only claims what the video shows, and 10 tags. ${PLAN_RULE} Video: {input}`,
    produces: 'metadata', keywords: ['seo', 'title', 'tags', 'description', 'metadata'],
  }),
  C('yt-publish', 'youtube', 'BUILD', 'Upload or schedule approved videos.', {
    does: 'Runs one Office video pass: a topic from your trend feeds, a sourced package, a render, and an UNLISTED upload to your channel. Making it public stays your decision on YouTube.',
    confirm: 'Uploads a video to your YouTube channel.',
    needs: ['model', 'video_renderer', 'youtube'], route: 'che_video_line', local: 'video_line', handler: 'video_line.runVideoLine → youtube_upload.js',
    input: null,
    examples: ['Run the video line', 'Publish the next video to my channel'],
    prompt: 'Run one Office video pass and upload it unlisted.',
    produces: 'youtube link', evidence: 'The YouTube video link returned by the upload.', keywords: ['publish', 'upload', 'youtube upload', 'post video'],
  }),
  C('yt-batch', 'youtube', 'BUILD', 'Coordinate multiple video projects.', {
    does: 'Hands a batch of video topics to the Office crew as tracked jobs.',
    needs: ['office'], route: 'office:goal', handler: 'office goal → agent_runtime.queueAgentTask',
    input: { name: 'topics', required: true, hint: 'Several topics' },
    examples: ['Tell the office to script videos about Mars, Venus and Jupiter'],
    prompt: 'Tell the office to prepare faceless video scripts for these topics: {input}',
    produces: 'office jobs', evidence: 'Office job ids.', keywords: ['batch', 'several videos', 'multiple videos'],
  }),
  C('yt-analytics', 'youtube', 'EXPLORE', 'Analyze actual channel data.', {
    does: 'Reports your channel connection and the uploads CHE made, from YouTube\'s own responses. Full YouTube Analytics reports are not connected yet.',
    needs: ['youtube'], route: 'che_youtube_status', local: 'youtube_status', handler: 'youtube_connection.youtubeStatus + data.youtube_uploads',
    input: null,
    examples: ['YouTube channel status', 'Which videos have you uploaded?'],
    prompt: 'YouTube channel status and uploads.',
    produces: 'channel data', evidence: 'Only data YouTube returned.', keywords: ['analytics', 'views', 'channel stats', 'performance'],
  }),
  C('yt-grow', 'youtube', 'PLAN', 'Recommend improvements based on results.', {
    does: 'Suggests next experiments from results you share or CHE has recorded, labeled as suggestions.',
    input: { name: 'results', required: false, hint: 'Results to learn from' },
    examples: ['How can I grow my faceless channel?'],
    prompt: `Recommend 5 concrete experiments to grow my faceless YouTube channel based on these results: {input}. ${NUMBERS_RULE} ${PLAN_RULE}`,
    produces: 'growth plan', keywords: ['grow', 'growth', 'subscribers', 'improve channel'],
  }),
  // Creator Studio (owner issue #347): the original series and its pilot,
  // answered from creator_studio.js with no model. Rendering reuses the free
  // GitHub renderer; posting reuses the owner's YouTube sign-in and asks first.
  C('studio-bible', 'studio', 'EXPLORE', 'Read the original series bible.', {
    does: 'Reads the Street Smart Explainers series bible: premise, recurring cast, tone rules, setting and episode format. All original; nothing from the reference videos.',
    needs: [], route: 'che_creator_studio', local: 'studio_bible', handler: 'creator_studio.SERIES_BIBLE + validateBible',
    input: null, examples: ['Show the series bible', 'Who is in the cast of Street Smart Explainers?'],
    prompt: 'Show the series bible.', produces: 'series bible', evidence: 'The stored bible and its checks.', keywords: ['series bible', 'cast', 'characters', 'street smart explainers'],
  }),
  C('studio-pilot', 'studio', 'PLAN', 'Read and check the pilot script.', {
    does: 'Reads the 40-second vertical pilot: scenes, narration, captions, shots, the cast in each shot and its sources, and checks it against the episode format.',
    needs: [], route: 'che_creator_studio', local: 'studio_pilot', handler: 'creator_studio.PILOT + validateEpisode',
    input: null, examples: ['Write the pilot script', 'Read me the pilot scenes'],
    prompt: 'Read me the pilot script.', produces: 'pilot script', evidence: 'The stored pilot spec, its checks and the sources each fact cites.', keywords: ['pilot', 'pilot script', 'episode', 'storyboard'],
  }),
  C('studio-render', 'studio', 'BUILD', 'Render the pilot as a vertical MP4.', {
    does: 'Renders the pilot on the free GitHub renderer as a 1080 by 1920 MP4 with burned-in captions, or reports its render status. Only a verified MP4 counts as done.',
    needs: ['video_renderer'], route: 'che_creator_studio', local: 'studio_render', handler: 'creator_studio → media.generateVideo → github_video_renderer.js',
    input: { name: 'request', required: false, hint: 'Say "status" to only check it' },
    examples: ['Render the pilot', 'Is the pilot ready?'],
    prompt: 'Render the pilot {input}', produces: 'video', evidence: 'A verified MP4 (length, size and codecs read from the file) in the media library.',
    cost: 'Free renderer on GitHub Actions; paid narration only if you turned Fish narration on.', keywords: ['render pilot', 'pilot video', 'pilot status'],
  }),
  C('studio-export', 'studio', 'PLAN', 'Package the pilot for one platform.', {
    does: 'Builds the pilot package for YouTube Shorts, TikTok, Instagram Reels or Facebook Reels and checks it: aspect, length, caption-safe zone, title, caption and hashtags. Posts nothing.',
    needs: [], optional: ['youtube'], route: 'che_creator_studio', local: 'studio_export', handler: 'creator_studio.exportPackage + EXPORT_PROFILES',
    input: { name: 'platform', required: true, hint: 'YouTube Shorts, TikTok, Instagram Reels or Facebook Reels' },
    examples: ['Export the pilot for TikTok', 'Package the pilot for Instagram Reels'],
    prompt: 'Export the pilot for {input}', produces: 'platform package', evidence: 'The package and each check it passed or failed.', keywords: ['export', 'tiktok', 'reels', 'shorts', 'platform'],
  }),
  C('studio-post', 'studio', 'BUILD', 'Post the pilot to one connected platform.', {
    does: 'Uploads the verified pilot MP4 unlisted to your YouTube channel as a Short. TikTok, Instagram and Facebook are not connected, so CHE says so and posts nothing there.',
    confirm: 'Uploads the pilot to the platform you named, unlisted.',
    needs: [], optional: ['youtube'], route: 'che_creator_studio', local: 'studio_post', handler: 'creator_studio → youtube_upload.uploadYouTube',
    input: { name: 'platform', required: true, hint: 'The platform, for example YouTube Shorts' },
    examples: ['Post the pilot to YouTube Shorts'],
    prompt: 'Post the pilot to {input}', produces: 'youtube link', evidence: 'The link YouTube returned for the upload.', keywords: ['post pilot', 'upload pilot', 'youtube shorts'],
  }),
  C('studio-growth', 'studio', 'EXPLORE', 'Audience-growth plan and real results.', {
    does: 'Reads the growth experiments and the pilot\'s real numbers from connected platforms. With nothing connected it says no data; it never estimates views.',
    needs: [], optional: ['youtube'], route: 'che_creator_studio', local: 'studio_growth', handler: 'creator_studio.GROWTH_PLAN + youtube_upload.youtubeVideoStatistics',
    input: null, examples: ['Show the growth experiments', 'How is the pilot doing?'],
    prompt: 'Show the growth experiments.', produces: 'growth report', evidence: 'Only statistics a platform returned.', keywords: ['audience growth', 'growth experiments', 'pilot views'],
  }),

  // ── Trading ───────────────────────────────────────────────────────────
  C('trade-open', 'trading', 'EXPLORE', 'New York session market briefing.', {
    does: 'Reads live NQ candles from public data and reports trend, swings and patterns before the 9:30 New York open.',
    needs: ['market_data'], route: 'che_trading', handler: 'trading_lab.analyze (Stooq/Binance candles)',
    input: { name: 'symbol', required: false, hint: 'NQ by default' },
    examples: ["What's NQ doing at the open?", 'Give me the New York open briefing'],
    prompt: 'Analyze the {input} chart for the New York open',
    produces: 'market read', evidence: 'Candle data with its source and time.', keywords: ['open', 'new york', 'nq', 'premarket', 'briefing', 'market'],
  }),
  C('trade-chart', 'trading', 'EXPLORE', 'Analyze NQ/MNQ market structure.', {
    does: 'Analyzes trend, swing highs and lows and candle patterns from real candles.',
    needs: ['market_data'], route: 'che_trading', handler: 'trading_lab.analyze',
    input: { name: 'symbol', required: false, hint: 'NQ, MNQ, ES, BTC…' },
    examples: ['Analyze the NQ chart', 'Show me swing highs on MNQ'],
    prompt: 'Analyze the {input} chart', produces: 'market read', evidence: 'Candle data with its source and time.', keywords: ['chart', 'structure', 'swing', 'trend', 'nq', 'mnq'],
  }),
  C('trade-setup', 'trading', 'EXPLORE', 'Identify conditional setups.', {
    does: 'Lists entry points the learned strategies see in real candles, as conditions, never as advice to trade.',
    needs: ['market_data'], route: 'che_trading', handler: 'trading_lab.analyze (learned strategies)',
    input: { name: 'symbol', required: false, hint: 'NQ by default' },
    examples: ['Any entry points on NQ?', 'Find setups on MNQ'],
    prompt: 'Analyze {input} entry points on the chart', produces: 'setups', keywords: ['setup', 'entry', 'entries', 'signal'],
  }),
  C('trade-liquidity', 'trading', 'EXPLORE', 'Analyze VWAP, liquidity, order blocks, and key levels.', {
    does: 'Marks swing highs and lows (where liquidity rests) from real candles. VWAP and order-block math are not computed yet; CHE says so instead of guessing.',
    needs: ['market_data'], route: 'che_trading', handler: 'trading_lab.analyze (swings)',
    input: { name: 'symbol', required: false, hint: 'NQ by default' },
    examples: ['Where is the liquidity on NQ?'],
    prompt: 'Analyze {input} swing highs and lows on the chart', produces: 'levels', keywords: ['liquidity', 'vwap', 'order block', 'levels', 'key levels'],
  }),
  C('trade-risk', 'trading', 'EXPLORE', 'Evaluate risk and account limits.', {
    does: 'Reports the trading mode, contract size and account CHE trades on. Account balance needs your NinjaTrader connection.',
    needs: ['office'], optional: ['broker'], route: 'che_trading_desk', handler: 'trading_desk.speakDeskStatus',
    input: null,
    examples: ['What trading mode am I on?'],
    prompt: 'What trading mode am I on?', produces: 'risk status', evidence: 'Desk state and broker responses only.', keywords: ['risk', 'account', 'limits', 'drawdown', 'position size'],
  }),
  C('trade-backtest', 'trading', 'EXPLORE', 'Test historical strategies.', {
    does: 'Backtests CHE\'s learned strategies on real historical candles and reports win rate and drawdown.',
    needs: ['market_data'], route: 'che_trading', handler: 'trading_lab.backtestAll',
    input: { name: 'symbol', required: false, hint: 'Symbol to test' },
    examples: ['Backtest NQ', 'Backtest bitcoin strategies'],
    prompt: 'Backtest {input}', produces: 'backtest', evidence: 'Results computed from historical candles, with the period.', keywords: ['backtest', 'historical', 'strategy test'],
  }),
  C('trade-journal', 'trading', 'EXPLORE', 'Document trades and outcomes.', {
    does: 'Reads your paper-trading book: open and closed trades and results.',
    needs: ['office'], route: 'che_trading', handler: 'trading_lab.speakBook',
    input: null,
    examples: ['Read my trading journal', 'How are my paper trades doing?'],
    prompt: 'Trading journal', produces: 'journal', keywords: ['journal', 'trade log', 'paper trades', 'results'],
  }),
  C('trade-alert', 'trading', 'EXPLORE', 'Create supported market alerts.', {
    does: 'Reads the desk\'s current entry alerts. New alerts come from symbols CHE paper-trades and watches.',
    needs: ['office'], route: 'che_trading_desk', handler: 'trading_desk.pendingAlert',
    input: null,
    examples: ['Any trade alerts?'],
    prompt: 'Any trade alerts?', produces: 'alerts', keywords: ['alert', 'notify', 'watch', 'alarm'],
  }),
  C('trade-execute', 'trading', 'BUILD', 'Prepare authorized broker actions with confirmation.', {
    does: 'Places the current desk alert on your selected NinjaTrader account as a bracket order. Live accounts risk real money.',
    confirm: 'Places a real order on your broker account.',
    needs: ['broker'], route: 'che_trading_desk', handler: 'trading_desk.takeTrade → broker_tradovate.placeBracket',
    input: null,
    examples: ['Take the trade'],
    prompt: 'Yes, take the trade', produces: 'order receipt', evidence: 'The broker\'s order id.', cost: 'Real money on a live account.', keywords: ['execute', 'place order', 'take the trade', 'buy', 'sell'],
  }),
  // Reads the owner-only connections of #348. It never connects, removes keys or goes live.
  C('trade-connections', 'trading', 'EXPLORE', 'Read your trading connections and mode.', {
    does: 'Reads each trading connection as it reports itself: CHE Paper and its data feed, Tradovate (NinjaTrader), Alpaca stock paper and FundYourEdge, plus the trading mode. Changes nothing.',
    needs: ['office'], route: 'che_trading_desk', handler: 'trading_connections.speakConnections',
    input: null,
    examples: ['What are my trading connections?', 'Which brokers are connected?'],
    prompt: 'What are my trading connections?', produces: 'connections', evidence: 'Each connection\'s stored state and its provider\'s own check; never a key.',
    keywords: ['connections', 'broker', 'brokers', 'alpaca', 'tradovate', 'connected'],
  }),

  // ── Websites, Apps & AI ───────────────────────────────────────────────
  C('site-build', 'build', 'BUILD', 'Create websites.', {
    does: 'Builds a real website or small web app and hosts a private preview on CHE. Nothing is public until you publish.',
    needs: ['model', 'site_hosting'], route: 'che_site_builder', handler: 'site_builder.js (writeSite, saveSite)',
    input: { name: 'site', required: true, hint: 'What the site is for' },
    examples: ['Build me a website for my barbershop', 'Build a booking page for my studio'],
    prompt: 'Build me a website for {input}', produces: 'site preview', evidence: 'The preview link CHE serves.', keywords: ['website', 'site', 'landing page', 'web app', 'booking'],
  }),
  C('site-redesign', 'build', 'BUILD', 'Improve existing sites.', {
    does: 'Edits the last site CHE built; the change stays a draft until you publish.',
    needs: ['model', 'site_hosting'], route: 'che_site_builder', handler: 'site_builder.siteEditIntent',
    input: { name: 'change', required: true, hint: 'What to change' },
    examples: ['Change the website: make the header dark teal'],
    prompt: 'Change the website: {input}', produces: 'site preview', keywords: ['redesign', 'change the website', 'improve site'],
  }),
  C('site-audit', 'build', 'EXPLORE', 'Audit performance, usability, accessibility, and SEO.', {
    does: 'Reviews a site against accessibility, usability and SEO basics and lists concrete fixes. It reads only what you paste or CHE built.',
    input: { name: 'site', required: true, hint: 'Site address or what to check' },
    examples: ['Audit my barbershop website'],
    prompt: `Audit this website for accessibility, usability, speed and SEO and list concrete fixes, most important first. Say what you could not check. Site: {input}`,
    produces: 'audit', keywords: ['audit', 'seo audit', 'accessibility', 'performance'],
  }),
  C('site-publish', 'build', 'BUILD', 'Deploy approved websites.', {
    does: 'Publishes the latest draft of the site CHE built at its public link.',
    needs: ['site_hosting'], route: 'che_site_builder', handler: 'site_builder.publishSite',
    input: null,
    examples: ['Publish the website'],
    prompt: 'Publish the website', produces: 'public link', evidence: 'The public link.', keywords: ['publish site', 'go live', 'deploy site'],
  }),
  C('app-build', 'build', 'BUILD', 'Create applications.', {
    does: 'Builds a small web app (single page, hosted by CHE). Native App Store apps are planned with /che-plan.',
    needs: ['model', 'site_hosting'], route: 'che_site_builder', handler: 'site_builder.js (web apps)',
    input: { name: 'app', required: true, hint: 'What the app does' },
    examples: ['Build me a booking app', 'Build a habit tracker web app'],
    prompt: 'Build me a web app for {input}', produces: 'app preview', keywords: ['app', 'application', 'booking app', 'tool'],
  }),
  C('app-fix', 'build', 'BUILD', 'Diagnose and repair application defects.', {
    does: 'Fixes defects in CHE\'s own app through a reviewed coding job (draft pull request).',
    needs: ['model', 'github'], route: 'che_self_development', handler: 'self_development.js',
    input: { name: 'bug', required: true, hint: 'What is broken' },
    examples: ['Fix the Office screen freezing'],
    prompt: 'Fix your code: {input}. Open a draft pull request with a test.', produces: 'pull request', keywords: ['fix', 'bug', 'broken', 'crash', 'repair'],
  }),
  C('ai-build', 'build', 'PLAN', 'Create AI tools, assistants, and agents.', {
    does: 'Designs an AI assistant or agent: purpose, tools, data, safety rules and test cases. Use /site-build to give it a web page.',
    input: { name: 'assistant', required: true, hint: 'What the AI should do' },
    examples: ['Design an AI receptionist for my barbershop'],
    prompt: `Design an AI assistant: {input}. Give its purpose, the tools and data it needs, safety rules, what needs human approval, and 5 test conversations. ${PLAN_RULE}`,
    produces: 'design', keywords: ['ai', 'agent', 'assistant', 'chatbot', 'automation'],
  }),
  C('code-review', 'build', 'EXPLORE', 'Review code quality and tests.', {
    does: 'Inspects CHE\'s repository read-only and reports risks, missing tests and fixes, with file paths.',
    needs: ['model', 'github'], route: 'che_repository_inspection', handler: 'code_scout.inspectReferenceRepo',
    input: { name: 'area', required: true, hint: 'What to review' },
    examples: ['Review the trading desk code'],
    prompt: 'Review your codebase for bugs and missing tests in {input}, with file paths. Read-only, change nothing.',
    produces: 'review', evidence: 'File paths and lines from the current commit.', keywords: ['review', 'code review', 'quality', 'tests'],
  }),
  C('che-release', 'build', 'EXPLORE', 'Validate and release authorized changes.', {
    does: 'Reports the state and checks of CHE\'s latest self-update pull request. Merging and deploying stay separate owner decisions.',
    needs: ['github'], route: 'che_self_update', handler: 'self_update (PR status and checks)',
    input: null,
    examples: ['Check the pull request status'],
    prompt: 'Check the pull request status', produces: 'release status', evidence: 'Live version and deploy records.', keywords: ['release', 'deploy', 'deployed', 'live version', 'merge'],
  }),
  C('iphone-update', 'build', 'EXPLORE', 'Check iPhone builds, SideStore, and installation evidence.', {
    does: 'Reports the latest iPhone app build. Installing happens in SideStore and is confirmed by the app on its next launch.',
    needs: ['github'], route: 'che_app_build', handler: 'appBuildIntent (status) + lib/self_update',
    input: null,
    examples: ["What's the app build status?"],
    prompt: "What's the app build status", produces: 'build status', evidence: 'GitHub Actions run and release asset.', keywords: ['iphone', 'ipa', 'sidestore', 'update', 'install', 'build status'],
  }),

  // REA (reverse engineering and investigation). Every REA command routes to
  // rea_runner.js. Investigating reads public sources only (npm packages on the
  // pinned GitHub runner, public GitHub repositories, public web pages, App
  // Store listings) and never starts a coding job. /rea-build is the one step
  // that changes code: it hands an approved plan to CHE's existing
  // self-development job, which opens a draft pull request and never merges.
  C('rea-inspect', 'build', 'EXPLORE', 'Investigate an app, website, repository or package (REA).', {
    title: 'REA: investigate',
    does: 'Investigates a public GitHub repository, web page, App Store listing or npm package and maps its features and architecture with citations. Packages run REA 6.5.0 on GitHub Actions. Nothing from the target runs here, and no coding job, commit or deploy starts.',
    // Repositories, pages and listings are public reads; only npm packages need the GitHub runner, and the handler says so.
    needs: [], optional: ['github'], route: 'che_rea', handler: 'rea_runner.js (rea_targets.js adapters; REA 6.5.0 for npm in the che-rea-analysis workflow)',
    input: { name: 'target', required: true, hint: 'An app name, link, GitHub repository, or npm:name@version' },
    examples: ['REA inspect: https://github.com/excalidraw/excalidraw', 'Investigate the Excalidraw app and tell me how its features work', 'REA inspect: npm:semver@7.7.2'],
    prompt: 'REA inspect: {input}',
    produces: 'investigation', evidence: 'Every feature and finding cites the file and line, page, or listing it came from; unknowns are listed.',
    cost: 'Free: public GitHub, web pages, the App Store listing API, the npm registry and GitHub Actions.',
    keywords: ['reverse engineer', 'rea', 'investigate app', 'study this app', 'how does this app work', 'inspect package', 'npm package', 'website features'],
    aliases: ['rea-investigate'],
  }),
  C('rea-discover', 'build', 'EXPLORE', 'Identify software and the public sources REA can use.', {
    title: 'REA: discover sources',
    does: 'Identifies an app by name or link and lists the public sources REA can read (repository, website, App Store listing) and what it cannot reach. Reads nothing in depth.',
    needs: [], route: 'che_rea', handler: 'rea_runner.js (rea_targets.identifyTarget, GitHub and App Store search)',
    input: { name: 'target', required: true, hint: 'An app name or link' },
    examples: ['REA discover: Excalidraw'],
    prompt: 'REA discover: {input}',
    produces: 'source list', evidence: 'Each source is a real link CHE found; nothing is assumed.',
    keywords: ['discover', 'identify app', 'find the source', 'which sources'],
  }),
  C('rea-features', 'build', 'EXPLORE', 'Map an investigated app\'s features, screens and interactions.', {
    title: 'REA: feature map',
    does: 'Lists each feature REA found with its purpose, how it is used, the evidence, unknowns and effort. Uses the recorded investigation; nothing new is run.',
    needs: [], route: 'che_rea', handler: 'rea_runner.js (rea_features.buildFeatureMap over recorded evidence)',
    input: { name: 'investigation', required: false, hint: 'REA job id, or leave empty for the latest' },
    examples: ['REA features', 'Map the features of that app'],
    prompt: 'REA features: {input}',
    produces: 'feature map', evidence: 'Each feature names its file, page or listing evidence.',
    keywords: ['feature map', 'map features', 'screens', 'interactions', 'what can it do'],
    aliases: ['rea-map'],
  }),
  C('rea-explain', 'build', 'EXPLORE', 'Explain how investigated software is built, from evidence.', {
    title: 'REA: architecture',
    does: 'Explains the architecture REA recorded (frameworks, entry points, navigation, storage, tests) and separates what was observed from what is inferred or unknown.',
    needs: [], route: 'che_rea', handler: 'rea_runner.js (recorded evidence)',
    input: { name: 'question', required: false, hint: 'REA job id or npm:name@version, and what to explain' },
    examples: ['REA explain: npm:semver@7.7.2', 'REA architecture'],
    prompt: 'REA explain: {input}',
    produces: 'explanation', evidence: 'Each finding is labelled observed, inferred or unknown, with its source.',
    keywords: ['explain how', 'how does it work', 'how is this built', 'architecture', 'dependencies'],
    aliases: ['rea-architecture'],
  }),
  C('rea-debug', 'build', 'EXPLORE', 'Investigate a software problem from evidence.', {
    title: 'REA: debug from evidence',
    does: 'Reviews a package\'s static evidence for a reported problem. REA cannot see a crash, so the result is static only and says so.',
    needs: ['github'], route: 'che_rea', handler: 'rea_runner.js (REA static evidence)',
    input: { name: 'problem', required: true, hint: 'npm package and exact version, and the symptom' },
    examples: ['REA debug: npm:semver@7.7.2 a valid range is rejected'],
    prompt: 'REA debug: {input}',
    produces: 'debug notes', evidence: 'Static facts only; runtime behaviour is labeled as not observed.',
    keywords: ['debug', 'crash', 'bug', 'broken', 'not working', 'investigate'],
  }),
  C('rea-compare', 'build', 'EXPLORE', 'Compare investigated software with CHE\'s own code.', {
    title: 'REA: compare with CHE',
    does: 'Checks each feature REA found against CHE\'s live repository and command catalog, says whether CHE has it, partly has it or lacks it, with the files, and recommends the useful gaps.',
    // The comparison reads CHE's repository, so its name is required; the token only adds code search.
    needs: ['repo'], optional: ['github'], route: 'che_rea', handler: 'rea_runner.js (rea_features.compareWithChe over CHE\'s repository at main)',
    input: { name: 'feature', required: false, hint: 'REA job id, or leave empty for the latest investigation' },
    examples: ['REA compare', 'Which of those features could improve your app?'],
    prompt: 'REA compare: {input}',
    produces: 'comparison', evidence: 'Each "CHE has it" names CHE\'s file at the current commit; a check that could not run says unknown.',
    keywords: ['compare', 'difference', 'versus', 'features you are missing', 'gap', 'could improve'],
    aliases: ['rea-gap'],
  }),
  C('rea-rebuild', 'build', 'PLAN', 'Plan an original version of chosen features.', {
    title: 'REA: plan',
    does: 'Writes an original-implementation plan with acceptance checks for the features you choose, from recorded evidence. Nothing is built.',
    needs: [], route: 'che_rea', handler: 'rea_runner.js (rea_features.planFor over recorded evidence)',
    input: { name: 'feature', required: true, hint: 'Feature numbers or names, and optionally the REA job id' },
    examples: ['REA plan: f2 f4', 'REA rebuild: the search feature'],
    prompt: 'REA rebuild: {input}',
    produces: 'build plan', evidence: 'Each planned step names the REA evidence it relies on.',
    keywords: ['rebuild', 'build a similar', 'original feature', 'implement from findings', 'plan'],
    aliases: ['rea-plan'],
  }),
  C('rea-build', 'build', 'BUILD', 'Build an approved REA plan into CHE as a draft PR.', {
    title: 'REA: build',
    does: 'Hands the approved plan to CHE\'s existing coding job: original code, tests and review, then a draft pull request. Nothing merges or deploys without your separate yes.',
    needs: ['model', 'github'], route: 'che_rea', handler: 'rea_runner.js → worker.queueSelfDevelopment (draft PR pipeline)',
    input: { name: 'plan', required: false, hint: 'REA job id, or leave empty for the latest plan' },
    examples: ['REA build', 'Build those features into yourself'],
    prompt: 'REA build: {input}',
    produces: 'pull request', evidence: 'The coding job id, then the pull request number, CI checks and review outcome.',
    keywords: ['build those features', 'build it into yourself', 'implement the plan'],
  }),
  C('rea-verify', 'build', 'EXPLORE', 'Check a REA build against its acceptance checks.', {
    title: 'REA: verify',
    does: 'Reads the build\'s pull request, its CI checks and changed tests, and says which acceptance checks are proven. The iPhone itself is never claimed verified.',
    needs: ['github'], route: 'che_rea', handler: 'rea_runner.js (rea_features.verifyBuild over GitHub)',
    input: { name: 'investigation', required: false, hint: 'REA job id, or leave empty for the latest build' },
    examples: ['REA verify'],
    prompt: 'REA verify: {input}',
    produces: 'verification', evidence: 'Pull request, check-run results and test files from GitHub.',
    keywords: ['verify build', 'did it pass', 'acceptance checks'],
  }),
  C('rea-status', 'build', 'EXPLORE', 'Show REA investigations, capabilities and results.', {
    title: 'REA: status and capabilities',
    does: 'Shows what REA can and cannot analyze, recent investigations with their stage, and the latest finished evidence.',
    needs: [], route: 'che_rea', handler: 'rea_runner.js (investigation log and the che-mailbox results)',
    input: null,
    examples: ['REA status', 'What can REA analyze?'],
    prompt: 'REA status',
    produces: 'job status', evidence: 'Job ids and the result records they were read from.',
    keywords: ['rea status', 'rea history', 'analysis status', 'reverse engineering jobs', 'rea capabilities'],
    aliases: ['rea-capabilities', 'rea-history'],
  }),

  // ── Money Management ──────────────────────────────────────────────────
  C('money-dashboard', 'money', 'EXPLORE', 'Financial overview from connected records.', {
    does: 'Reads today\'s Office earnings and Stripe sales. CHE has no bank feed, so spending is only what you tell her.',
    needs: ['office'], optional: ['stripe'], route: 'office:earnedToday', handler: 'office_board.officeToday + Stripe webhook totals',
    input: null,
    examples: ['How much did we make today?'],
    prompt: 'How much did we make today?', produces: 'financial snapshot', evidence: 'Stripe and Office records only.', keywords: ['money', 'dashboard', 'earnings', 'revenue', 'made today'],
  }),
  C('cashflow', 'money', 'PLAN', 'Analyze income and outgoings.', {
    does: 'Analyzes the income and outgoings you give CHE (no bank connection) and shows where money goes.',
    optional: ['stripe'], input: { name: 'numbers', required: true, hint: 'Your income and expenses' },
    examples: ['Analyze my cash flow: income 4000, rent 1500, ads 300'],
    prompt: `Analyze this cash flow: {input}. ${NUMBERS_RULE}`, produces: 'cash flow', keywords: ['cash flow', 'income', 'outgoings', 'spending'],
  }),
  C('budget', 'money', 'PLAN', 'Create spending budgets.', {
    does: 'Builds a monthly budget from your numbers and goals.',
    input: { name: 'numbers', required: true, hint: 'Income, bills and goals' },
    examples: ['Make me a budget: I earn 5000 a month and want to save 1000'],
    prompt: `Create a monthly budget from this: {input}. ${NUMBERS_RULE}`, produces: 'budget', keywords: ['budget', 'save money', 'spending plan'],
  }),
  C('expenses', 'money', 'PLAN', 'Categorize expenses.', {
    does: 'Sorts the expenses you list into categories with totals.',
    input: { name: 'expenses', required: true, hint: 'Your expense list' },
    examples: ['Categorize these expenses: Adobe 55, Uber 23, ads 300'],
    prompt: `Categorize these expenses with totals per category: {input}. ${NUMBERS_RULE}`, produces: 'expense report', keywords: ['expenses', 'categorize', 'receipts', 'costs'],
  }),
  C('invoices', 'money', 'PLAN', 'Prepare and track invoices.', {
    does: 'Drafts an invoice from the details you give. It charges no one: Stripe payment links are made only from a client-pipeline deal, with your approval, and /lead-crm shows which deals are paid.',
    route: 'model', handler: 'ai_router (draft); pipeline.createPaymentLink stays a separate, approved step',
    input: { name: 'invoice', required: true, hint: 'Client, work and amount' },
    examples: ['Invoice Joe\'s Barbershop 800 dollars for the website'],
    prompt: `Draft an invoice: {input}. ${NUMBERS_RULE}`, produces: 'invoice', cost: 'Stripe charges its standard fee per payment.', keywords: ['invoice', 'bill', 'payment link', 'charge client'],
  }),
  C('money-forecast', 'money', 'PLAN', 'Project future cash flow.', {
    does: 'Projects the next months from your numbers, with the assumptions stated.',
    input: { name: 'numbers', required: true, hint: 'Current numbers and plans' },
    examples: ['Forecast my next 6 months if I land 3 website clients a month at 800'],
    prompt: `Forecast my cash flow from this, stating every assumption: {input}. ${NUMBERS_RULE}`, produces: 'forecast', keywords: ['forecast', 'projection', 'next months'],
  }),
  C('pricing', 'money', 'PLAN', 'Estimate profitable service prices.', {
    does: 'Works out prices from your costs, hours and target profit; market rates only when researched with sources.',
    input: { name: 'service', required: true, hint: 'Service, hours, costs' },
    examples: ['How much should I charge for a 5 page website?'],
    prompt: `Estimate a profitable price for: {input}. Show the math from my costs and hours; mark market rates as needing research unless you cite a source. ${NUMBERS_RULE}`, produces: 'price', keywords: ['price', 'pricing', 'charge', 'rate', 'how much should i charge'],
  }),
  C('profit-report', 'money', 'EXPLORE', 'Report revenue, expenses, and profit.', {
    does: 'Reports profit from the revenue and costs you give plus Stripe sales when connected.',
    optional: ['stripe'], input: { name: 'numbers', required: false, hint: 'Revenue and costs' },
    examples: ['Profit report for this month'],
    prompt: `Make a profit report from: {input}. ${NUMBERS_RULE}`, produces: 'profit report', keywords: ['profit', 'revenue', 'report', 'p&l'],
  }),

  // ── Client Scouting & Service Fulfillment ─────────────────────────────
  C('lead-scout', 'clients', 'EXPLORE', 'Find potential clients using lawful business information.', {
    does: 'The Office opportunity scout shortlists public business leads for your review. It never messages anyone.',
    needs: ['office'], route: 'office:opportunityScout', handler: 'opportunity_scout.buildOpportunityScoutTask (Office)',
    input: { name: 'market', required: true, hint: 'Who to look for' },
    examples: ['Scout leads for barbershops without websites in Phoenix'],
    prompt: 'Scout leads for {input}', produces: 'leads', evidence: 'Each lead names its public source.', keywords: ['leads', 'clients', 'prospects', 'find clients', 'scout'],
  }),
  C('lead-audit', 'clients', 'EXPLORE', 'Identify verifiable service needs.', {
    does: 'Researches a business\'s public presence and lists needs you can verify (no website, broken links, no booking).',
    needs: ['model', 'research'], input: { name: 'business', required: true, hint: 'Business name or site' },
    examples: ['Audit Joe\'s Barbershop in Phoenix for website needs'],
    prompt: 'Research the public online presence of {input} and list only service needs you can verify from real sources, with the sources.',
    produces: 'needs', evidence: 'Every need cites what was observed.', keywords: ['audit lead', 'needs', 'business check'],
  }),
  C('lead-score', 'clients', 'PLAN', 'Prioritize opportunities.', {
    does: 'Ranks the leads you give by fit, urgency and value, explaining each score.',
    input: { name: 'leads', required: true, hint: 'Leads to rank' },
    examples: ['Score these leads: …'],
    prompt: `Score and rank these leads by fit, urgency and likely value, explaining each score: {input}. ${NUMBERS_RULE}`, produces: 'ranked leads', keywords: ['score', 'prioritize', 'rank leads'],
  }),
  C('lead-match', 'clients', 'PLAN', 'Match needs to services CHE can deliver.', {
    does: 'Matches each need to a service CHE can actually deliver today (sites, web apps, videos, content).',
    input: { name: 'needs', required: true, hint: 'Client needs' },
    examples: ['Which of my services fit a barbershop with no booking page?'],
    prompt: `Match these client needs to services CHE can deliver today (websites and web apps, faceless videos, written content, research), and say which needs CHE cannot deliver: {input}. ${PLAN_RULE}`,
    produces: 'service match', keywords: ['match', 'services', 'offer'],
  }),
  C('lead-proposal', 'clients', 'PLAN', 'Prepare proposals.', {
    does: 'Drafts a proposal with scope, timeline and price for your review. Nothing is sent.',
    input: { name: 'client', required: true, hint: 'Client and work' },
    examples: ['Draft a proposal for Joe\'s Barbershop website'],
    prompt: `Draft a client proposal: {input}. Scope, deliverables, timeline, price, next step. ${NUMBERS_RULE} ${PLAN_RULE}`, produces: 'proposal', keywords: ['proposal', 'quote', 'pitch'],
  }),
  C('lead-outreach', 'clients', 'PLAN', 'Draft and send authorized communications.', {
    does: 'Drafts a short, honest outreach message with an easy opt-out. It sends nothing: you review it and send it yourself. No bulk or cold messaging.',
    input: { name: 'message', required: true, hint: 'Who and what to say' },
    examples: ['Draft an outreach text to Joe\'s Barbershop about a new website'],
    prompt: `Draft a short, honest outreach message (no false claims, an easy opt-out) for: {input}. Do not send it.`,
    produces: 'message draft', keywords: ['outreach', 'contact', 'message client', 'cold email', 'text'],
  }),
  C('lead-crm', 'clients', 'EXPLORE', 'Track client opportunities.', {
    does: 'Reads the deals in CHE\'s client pipeline and their stages.',
    needs: ['office'], route: 'che_pipeline', local: 'pipeline', handler: 'pipeline.pipelineSummary', input: null,
    examples: ['What is in my client pipeline?'],
    prompt: 'Client pipeline summary.', produces: 'pipeline', evidence: 'Pipeline records only.', keywords: ['crm', 'pipeline', 'deals', 'clients list'],
  }),
  C('lead-followup', 'clients', 'PLAN', 'Manage authorized follow-up workflows.', {
    does: 'Drafts polite follow-ups for leads that went quiet. It sends nothing; you review and send.',
    input: { name: 'lead', required: true, hint: 'Who to follow up' },
    examples: ['Draft a follow-up to Joe\'s Barbershop'],
    prompt: 'Draft a short, polite follow-up message with an easy opt-out for: {input}. Do not send it.', produces: 'message draft', keywords: ['follow up', 'followup', 'reminder'],
  }),
  C('client-deliver', 'clients', 'BUILD', 'Coordinate agreed-upon project deliverables.', {
    does: 'Hands the agreed deliverables to the Office crew as tracked jobs and reports progress.',
    needs: ['office'], route: 'office:goal', input: { name: 'project', required: true, hint: 'Client and deliverables' },
    examples: ['Tell the office to deliver Joe\'s Barbershop website'],
    prompt: 'Tell the office to deliver this client project: {input}', produces: 'office jobs', evidence: 'Office job ids and their results.', keywords: ['deliver', 'deliverables', 'project delivery'],
  }),

  // ── Marketing & Sales ─────────────────────────────────────────────────
  C('brand-build', 'marketing', 'PLAN', 'Create business branding.', {
    does: 'Creates a brand kit: name options, voice, colors, logo direction and taglines.',
    input: { name: 'business', required: true, hint: 'Your business' },
    examples: ['Build a brand for my web design studio'],
    prompt: `Create a brand kit for {input}: 5 name options, brand voice, 3 colors with hex codes, logo direction and 5 taglines. ${PLAN_RULE}`, produces: 'brand kit', keywords: ['brand', 'logo', 'branding', 'name'],
  }),
  C('marketing-plan', 'marketing', 'PLAN', 'Plan marketing campaigns.', {
    does: 'Plans a campaign: audience, channels, message, a 30-day calendar and how to measure it.',
    input: { name: 'goal', required: true, hint: 'What to market' },
    examples: ['Marketing plan for my web design service'],
    prompt: `Write a marketing plan for {input}: audience, channels, key message, 30-day calendar, and how to measure results. ${NUMBERS_RULE} ${PLAN_RULE}`, produces: 'marketing plan', keywords: ['marketing', 'campaign', 'promote'],
  }),
  C('social-content', 'marketing', 'PLAN', 'Create social media content.', {
    does: 'Writes ready-to-post captions and post ideas. Posting stays with you.',
    input: { name: 'topic', required: true, hint: 'Topic and platform' },
    examples: ['Write 5 Instagram posts for my barbershop'],
    prompt: `Write 5 ready-to-post social media posts for {input}, with captions and hashtags. ${PLAN_RULE}`, produces: 'posts', keywords: ['social', 'instagram', 'tiktok', 'posts', 'content'],
  }),
  C('ads-plan', 'marketing', 'PLAN', 'Prepare advertising campaigns.', {
    does: 'Prepares ad copy, audiences and a test budget plan. CHE has no ad-account connection and never spends.',
    input: { name: 'campaign', required: true, hint: 'Product and budget' },
    examples: ['Plan a 200 dollar Facebook ad test for my studio'],
    prompt: `Prepare an advertising campaign plan for {input}: audiences, 3 ad copies, a test budget split, and success metrics. ${NUMBERS_RULE} ${PLAN_RULE}`, produces: 'ad plan', keywords: ['ads', 'advertising', 'facebook ads', 'google ads'],
  }),
  C('seo-growth', 'marketing', 'PLAN', 'Improve organic search opportunities.', {
    does: 'Plans keywords, pages and content for organic search growth.',
    input: { name: 'site', required: true, hint: 'Business or site' },
    examples: ['SEO plan for my barbershop site'],
    prompt: `Write an SEO growth plan for {input}: target keywords, pages to create, on-page fixes, and a content calendar. Mark search volumes as unknown unless a source gives them. ${PLAN_RULE}`, produces: 'seo plan', keywords: ['seo', 'google ranking', 'organic', 'keywords'],
  }),
  C('sales-funnel', 'marketing', 'PLAN', 'Design client acquisition workflows.', {
    does: 'Designs a funnel from first contact to paid client, with the message and offer at each stage.',
    input: { name: 'offer', required: true, hint: 'What you sell' },
    examples: ['Design a sales funnel for my website service'],
    prompt: `Design a sales funnel for {input}: stages, offer and message at each stage, and what to measure. ${PLAN_RULE}`, produces: 'funnel', keywords: ['funnel', 'sales', 'conversion', 'acquisition'],
  }),
  C('business-launch', 'marketing', 'PLAN', 'Plan business launches.', {
    does: 'Plans a launch: checklist, timeline, first offers and first customers.',
    input: { name: 'business', required: true, hint: 'What you are launching' },
    examples: ['Plan the launch of my web design business'],
    prompt: `Plan a business launch for {input}: checklist, 30-day timeline, first offer, and how to get the first 5 customers. ${PLAN_RULE}`, produces: 'launch plan', keywords: ['launch', 'start a business', 'new business'],
  }),

  // ── Office & Automation ───────────────────────────────────────────────
  C('office-status', 'office', 'EXPLORE', 'Report Office agent status.', {
    does: 'Reads the live Office board: who is working on what, what shipped and what is stalled.',
    needs: ['office'], route: 'office:happening', handler: 'office_board + office_phrases.speakOfficeBoard',
    input: null,
    examples: ["What's happening in the office?"],
    prompt: "What's happening in the office?", produces: 'office status', evidence: 'Office board records only.', keywords: ['office', 'agents', 'team', 'crew'],
  }),
  C('office-delegate', 'office', 'BUILD', 'Delegate suitable tasks.', {
    does: 'Gives the Office crew a goal; CHE splits it into tracked agent jobs.',
    needs: ['office'], route: 'office:goal', handler: 'office_company.splitGoal → agent_runtime.queueAgentTask',
    input: { name: 'task', required: true, hint: 'What the Office should do' },
    examples: ['Tell the office to research barbershops in Phoenix'],
    prompt: 'Tell the office to {input}', produces: 'office jobs', evidence: 'Office job ids.', keywords: ['delegate', 'office task', 'assign'],
  }),
  C('warroom', 'office', 'PLAN', 'Coordinate complex multi-agent work.', {
    does: 'Puts a hard question to Gemini, ChatGPT and Grok and gives each answer; an engine that cannot be reached is named, never faked.',
    needs: ['model'], route: 'che_consult', handler: 'ai_consult.consultIntent (peer engines)',
    input: { name: 'question', required: true, hint: 'The hard question' },
    examples: ['Ask Gemini and ChatGPT: should I focus on websites or videos first?'],
    prompt: 'Ask Gemini, ChatGPT and Grok: {input}', produces: 'panel answers', keywords: ['war room', 'warroom', 'round table', 'second opinion', 'multiple ais'],
  }),
  C('automate', 'office', 'PLAN', 'Create supported recurring workflows.', {
    does: 'Designs a repeatable workflow you save here and run with one tap or sentence. Unattended schedules stay off by your rule.',
    input: { name: 'routine', required: true, hint: 'What you repeat' },
    examples: ['Automate my Monday client follow-ups'],
    prompt: `Design a repeatable workflow for: {input}. List the steps in order, what each needs, and where my approval is required. Use CHE Command Center commands where they fit. ${PLAN_RULE}`,
    produces: 'workflow design', keywords: ['automate', 'automation', 'recurring', 'routine', 'every week'],
  }),
  C('skill-learn', 'office', 'BUILD', 'Improve existing skills using tested lessons.', {
    does: 'Teaches CHE a skill from text you give; secrets are removed and the skill is saved with its source.',
    needs: ['memory'], route: 'che_self_skills', handler: 'self_skills.learnSkillIntent → saveLearnedSkills',
    input: { name: 'skill', required: true, hint: 'The lesson or steps' },
    examples: ['Learn this skill: always check the NQ open range before entries'],
    prompt: 'Learn this skill: {input}', produces: 'learned skill', evidence: 'The saved skill with its source.', keywords: ['learn', 'skill', 'teach', 'lesson'],
  }),
  C('connect', 'office', 'EXPLORE', 'Help configure supported integrations.', {
    does: 'Tells you exactly how to connect a supported service and checks which keys work.',
    needs: ['model'], route: 'che_keys', handler: 'resilience.setupSteps / checkAllKeys',
    input: null,
    examples: ['Check my keys'],
    prompt: 'Check my keys', produces: 'setup steps', keywords: ['connect', 'integration', 'keys', 'setup', 'api key'],
  }),
  C('voice-test', 'office', 'EXPLORE', "Test CHE's actual voice systems.", {
    does: 'Checks which of CHE\'s voices answer right now (ElevenLabs, Fish) and reports real results. Hearing it on your phone is the final test.',
    needs: ['voice'], route: 'che_voice_test', local: 'voice_test', handler: 'voiceProbe (one real ElevenLabs call) + fishAudioKeyStatus',
    input: null,
    examples: ['Test your voice'],
    prompt: 'Run a voice test.', cost: 'One short ElevenLabs synthesis from your credits.', produces: 'voice status', evidence: 'A real synthesis result; only your ears confirm the phone.', keywords: ['voice', 'test voice', 'elevenlabs', 'speech'],
  }),
  C('create-3d', 'office', 'BUILD', 'Coordinate supported 3D content creation.', {
    does: 'Gives the Office a Roblox Studio job (games, items, UGC). Publishing or spending Robux needs your yes.',
    needs: ['office'], route: 'office:robloxJob', handler: 'roblox_studio.parseRobloxPhrase (Office robloxJob)',
    input: { name: 'project', required: true, hint: '3D game or item' },
    examples: ['Build a Roblox obby game'],
    prompt: 'Build a Roblox game: {input}', produces: 'office jobs', keywords: ['3d', 'roblox', 'game', 'model'],
  }),
]);

// Aliases are other names for one command (/rea-map is /rea-features), never a second command.
const BY_ID = new Map(COMMANDS.flatMap((c) => [[c.id, c], ...c.aliases.map((a) => [a, c])]));
export function commandById(id) { return BY_ID.get(String(id || '').toLowerCase().replace(/^\//, '')) || null; }

// ─── Availability ─────────────────────────────────────────────────────────

const truthy = (v) => Boolean(String(v ?? '').trim());

/**
 * Connector readiness from the Worker's real configuration. `facts` carries
 * state that needs storage (broker token, YouTube connection); anything not
 * known is reported as not connected, never as ready.
 */
export function connectorStatus(env = {}, facts = {}) {
  const runtime = facts.runtime || {};
  const ok = (detail = '') => ({ state: 'ready', detail });
  const missing = (detail) => ({ state: 'not_connected', detail });
  const out = {};
  const modelUp = runtime.chat !== undefined ? runtime.chat === true : Boolean(env.AI);
  out.model = modelUp ? ok() : { state: 'unavailable', detail: 'No AI engine answers right now.' };
  for (const id of ['research', 'market_data', 'office', 'memory', 'jobs', 'site_hosting']) out[id] = ok();
  out.broker = !(truthy(env.CHE_TRADOVATE_OAUTH_CLIENT_ID) && truthy(env.CHE_TRADOVATE_OAUTH_CLIENT_SECRET))
    ? missing('Tradovate OAuth app credentials are not set.')
    : facts.broker?.connected ? ok() : facts.broker?.expired ? { state: 'needs_reconnect', detail: 'The NinjaTrader sign-in expired.' } : missing('Not signed in to NinjaTrader.');
  out.youtube = facts.youtube?.connected ? ok(facts.youtube.channel_title || '')
    : facts.youtube?.status === 'needs_reconnect' ? { state: 'needs_reconnect', detail: 'Reconnect YouTube.' } : missing('YouTube is not connected.');
  out.video_renderer = (runtime.video_generation ?? Boolean(env.CHE_VIDEO_GEN_URL || env.CHE_VIDEO_RENDER_URL || (env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO))) ? ok() : missing('No video renderer is configured.');
  out.image_generation = (runtime.image_generation ?? Boolean(env.CHE_IMAGE_GEN_URL || env.AI)) ? ok() : missing('No image engine is configured.');
  out.voice = truthy(env.ELEVENLABS_API_KEY) || truthy(env.FISH_API_KEY) ? ok() : missing('No ElevenLabs or Fish key.');
  out.github = truthy(env.CHE_GITHUB_TOKEN) && truthy(env.CHE_GITHUB_REPO) ? ok() : missing('GitHub is not connected.');
  out.repo = truthy(env.CHE_GITHUB_REPO) ? ok() : missing('CHE_GITHUB_REPO is not set.');
  out.stripe = truthy(env.STRIPE_SECRET_KEY) || truthy(env.CHE_PAYMENTS_URL) ? ok() : missing('Stripe is not connected.');
  out.sms = truthy(env.TWILIO_ACCOUNT_SID) && truthy(env.TWILIO_AUTH_TOKEN) ? ok() : missing('Twilio is not connected.');
  out.bookkeeping = { state: 'none', detail: CONNECTORS.bookkeeping.setup };
  out.ads_account = { state: 'none', detail: CONNECTORS.ads_account.setup };
  out.fundyouredge = { state: 'none', detail: CONNECTORS.fundyouredge.setup };
  return out;
}

const STATE_ORDER = { none: 3, not_connected: 2, needs_reconnect: 2, unavailable: 1, ready: 0 };

/** available | setup_required | unsupported | temporarily_unavailable, with what is missing. */
export function commandStatus(command, connectors) {
  const blocking = command.needs.map((id) => ({ id, ...(connectors[id] || { state: 'not_connected', detail: 'Unknown connector.' }) }))
    .filter((c) => c.state !== 'ready')
    .sort((a, b) => STATE_ORDER[b.state] - STATE_ORDER[a.state]);
  const optionalMissing = command.optional.filter((id) => connectors[id]?.state !== 'ready');
  if (!blocking.length) return { status: 'available', missing: [], optional_missing: optionalMissing };
  const worst = blocking[0].state;
  const status = worst === 'none' ? 'unsupported' : worst === 'unavailable' ? 'temporarily_unavailable' : 'setup_required';
  return {
    status,
    missing: blocking.map((c) => ({ id: c.id, label: CONNECTORS[c.id]?.label || c.id, state: c.state, setup: CONNECTORS[c.id]?.setup || '', detail: c.detail || '' })),
    optional_missing: optionalMissing,
  };
}

const STATUS_WORDS = {
  setup_required: 'needs setup',
  unsupported: 'is not supported yet',
  temporarily_unavailable: 'is temporarily unavailable',
};

/** What CHE says when a command cannot run, with the exact missing piece. */
export function speakUnavailable(command, status) {
  const parts = status.missing.map((m) => `${m.label}: ${m.state === 'none' ? m.setup : `${m.detail} ${m.setup}`.trim()}`);
  return `/${command.id} ${STATUS_WORDS[status.status] || 'cannot run'}, sir. ${parts.join(' ')} Nothing was run.`;
}

/** The catalog as the phone shows it: every command with its live status. */
export function catalogView(connectors) {
  return {
    version: CATALOG_VERSION,
    categories: CATEGORIES,
    commands: COMMANDS.map((c) => {
      const s = commandStatus(c, connectors);
      return {
        id: c.id, category: c.category, title: c.title, summary: c.summary, does: c.does, mode: c.mode,
        approval: c.confirm ? { required: true, reason: c.confirm } : { required: false, reason: '' },
        input: c.input, examples: c.examples, needs: c.needs, optional: c.optional,
        handler: c.handler, route: c.route, produces: c.produces, evidence: c.evidence, cost: c.cost, keywords: c.keywords,
        status: s.status, missing: s.missing, optional_missing: s.optional_missing,
      };
    }),
    // The suggestion combinations double as ready-made workflow templates.
    templates: SUGGESTION_RULES.map((r) => ({ id: r.id, name: r.label, steps: r.commands.map((command) => ({ command, input: '', parallel: false })) })),
    connectors: Object.fromEntries(Object.entries(connectors).map(([id, c]) => [id, { ...c, label: CONNECTORS[id]?.label || id, setup: CONNECTORS[id]?.setup || '' }])),
  };
}
export const CATALOG_VERSION = 1;

// ─── Slash commands and natural language ──────────────────────────────────

const SLASH = /^\s*\/([a-z][a-z0-9-]{1,30})\b\s*([\s\S]*)$/i;

/** "/trade-chart NQ" → { id, command, input }. Unknown names keep their text. */
export function parseSlashCommand(message) {
  const m = SLASH.exec(String(message || ''));
  if (!m) return null;
  const name = m[1].toLowerCase();
  const command = BY_ID.get(name) || null;
  return { name, command, input: m[2].trim().slice(0, 4000) };
}

/** The request this command sends through /api/chat. */
export function dispatchPrompt(command, input = '') {
  const text = command.input ? String(input || '').replace(/\s+/g, ' ').trim().slice(0, 4000) : '';
  return command.prompt.replace('{input}', text).replace(/\s+([?.!,:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'my', 'me', 'i', 'is', 'it', 'with', 'how', 'can', 'do', 'what', 'some', 'want', 'make', 'get', 'che', 'please', 'help', 'your', 'you', 'about']);
const words = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9/& -]+/g, ' ').split(/[\s/-]+/).filter((w) => w.length > 1 && !STOP.has(w));
const stem = (w) => w.replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, '');

/**
 * Search by command name or by goal ("find website clients"). Deterministic
 * word overlap over names, summaries and keywords; best matches first.
 */
export function searchCommands(query, { limit = 10 } = {}) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return [];
  const exact = commandById(raw.replace(/\s+/g, '-'));
  const terms = [...new Set(words(raw).map(stem))];
  const scored = COMMANDS.map((c) => {
    let score = 0;
    if (exact && exact.id === c.id) score += 100;
    if (c.id.includes(raw.replace(/^\//, '').replace(/\s+/g, '-'))) score += 20;
    const name = new Set(words(c.id).map(stem));
    const body = new Set(words(`${c.title} ${c.summary} ${c.does}`).map(stem));
    const keys = c.keywords.join(' ').toLowerCase();
    for (const t of terms) {
      if (name.has(t)) score += 6;
      if (body.has(t)) score += 2;
      if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(keys)) score += 4;
    }
    for (const k of c.keywords) if (k.includes(' ') && raw.includes(k)) score += 8;
    return { c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || COMMANDS.indexOf(a.c) - COMMANDS.indexOf(b.c));
  return scored.slice(0, limit).map((x) => ({ id: x.c.id, score: x.score }));
}

// ─── Natural speech about CHE's own commands ─────────────────────────────
// The owner's spoken requests (iPhone, 2026-10-16), read the way the phone's
// Commands page reads them, so /api/chat answers them from the catalog with
// no model: "open your Commands page", "search for YouTube", "show me five
// YouTube commands and tell me which are ready", "show me number four",
// "run the video command". Anything else returns null.

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const numberOf = (w) => (/^\d{1,2}$/.test(w) ? Number(w) : NUMBER_WORDS[w] || null);
const NUM = '(\\d{1,2}|one|two|three|four|for|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth)';
// A group's bare name: "search for YouTube" means CHE's YouTube commands.
const GROUP_WORDS = { youtube: 'youtube', yt: 'youtube', trading: 'trading' };

function speechText(message) {
  return String(message || '').trim().toLowerCase().replace(/[’]/g, "'")
    .replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chay|chey|shay|c\.h\.e\.?)(?![a-z'])[\s,.:;!?-]*/, '')
    .replace(/^(?:please|can you|could you|would you)\s+/, '')
    .replace(/\b(?:you|u)[\s-]?tubes?\b/g, 'youtube')
    .replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * "video" names /yt-video: the words are a command id, or the end of
 * exactly one command's id. Returns { command, input } or { candidates }.
 */
export function commandFromWords(words) {
  const tokens = String(words || '').toLowerCase().replace(/^(?:the|my)\s+/, '').split(/\s+/).filter(Boolean)
    .map((w) => (w === 'youtube' ? 'yt' : w === 'chey' || w === 'chay' ? 'che' : w.replace(/^\//, '')));
  const id = (n) => tokens.slice(0, n).join('-');
  const rest = (n) => tokens.slice(n).join(' ').replace(/^(?:for|on|about|with|to)\s+/, '');
  for (let n = tokens.length; n >= 1; n--) if (BY_ID.has(id(n))) return { command: BY_ID.get(id(n)), input: rest(n) };
  for (let n = tokens.length; n >= 1; n--) {
    const named = COMMANDS.filter((c) => c.id.endsWith(`-${id(n)}`));
    if (named.length === 1) return { command: named[0], input: rest(n) };
    if (named.length > 1) return { candidates: named };
  }
  return null;
}

/** The numbered command list in CHE's last reply: index → command id. */
function listedCommands(history) {
  const last = [...(Array.isArray(history) ? history : [])].reverse().find((h) => String(h?.role) === 'assistant');
  const text = String(last?.content || last?.text || '');
  return [...text.matchAll(/(?:^|\s)(\d{1,2})\.\s+\/([a-z][a-z0-9-]{1,30})\b/g)].reduce((m, [, n, cid]) => (m[n] ||= cid, m), {});
}

/** What the owner asked about CHE's commands, or null. */
export function readCommandSpeech(message, history = []) {
  const t = speechText(message);
  if (!t || t.length > 300) return null;
  if (/^(?:open|go to|bring up|take me to|show(?: me)?)\s+(?:the |your |my |che's )?(?:commands?|command (?:center|library))(?: (?:page|screen|tab|list))?$/.test(t)) return { kind: 'open' };
  const search = /^(?:search|look)(?: for| up)? (.+)$/.exec(t);
  if (search && GROUP_WORDS[search[1]]) return { kind: 'list', topic: GROUP_WORDS[search[1]], count: 5, readiness: false };
  // "show me five youtube commands (and tell me which are ready)".
  const list = new RegExp(`^(?:show|list|read|give|tell)(?: me)? (?:the )?(?:${NUM} )?(?:(youtube|yt|trading) )?commands?(?: for (youtube|trading))?(?:,? (?:and )?(?:tell|show) me which (?:ones )?(?:are|is) (ready|working)(?: to use)?)?$`).exec(t);
  if (list && (list[2] || list[3])) return { kind: 'list', topic: GROUP_WORDS[list[2] || list[3]], count: numberOf(list[1] || '') || 5, readiness: Boolean(list[4]) };
  const pick = new RegExp(`^(?:show me|open|read|pick|tell me about)?\\s*(?:the )?(?:number|option) ${NUM}$|^${NUM}$`).exec(t);
  if (pick) {
    const n = numberOf(pick[1] || pick[2]);
    const id = listedCommands(history)[n];
    return id ? { kind: 'pick', number: n, command: BY_ID.get(id) || null, id } : { kind: 'pick', number: n, command: null, id: '' };
  }
  const run = /^(?:run|start|execute|launch|use)\s+(?:the |my )?(.+?) command(?:\s+(?:for|on|about|with)\s+(.+))?$/.exec(t);
  if (run && !/^(?:the|a|an|this|that|it)$/.test(run[1])) {
    const found = commandFromWords(run[1]);
    return { kind: 'run', words: run[1], command: found?.command || null, input: String(run[2] || found?.input || '').trim(), candidates: found?.candidates || [] };
  }
  return null;
}

/** The deterministic reply for a list request, with live states. */
export function speakCommandList(view, { topic = '', count = 5, readiness = false } = {}) {
  const group = CATEGORIES.find((c) => c.id === topic);
  const found = group ? view.commands.filter((c) => c.category === group.id) : searchCommands(topic, { limit: 25 }).map((r) => view.commands.find((c) => c.id === r.id)).filter(Boolean);
  if (!found.length) return `No command matches "${topic}", sir. Nothing was run.`;
  const shown = found.slice(0, count);
  const state = (c) => (c.status === 'available' ? 'Ready' : c.status === 'setup_required' ? `Needs setup: ${c.missing.map((m) => m.label).join(', ')}` : STATUS_WORDS[c.status] || c.status);
  const ready = shown.filter((c) => c.status === 'available').length;
  const setup = shown.filter((c) => c.status === 'setup_required').length;
  const other = shown.length - ready - setup;
  const tally = [`${ready} ready`, setup ? `${setup} need${setup === 1 ? 's' : ''} setup` : '', other ? `${other} not available now` : ''].filter(Boolean).join(', ');
  return `${group ? group.title : `"${topic}"`}: ${found.length} commands. ${shown.map((c, i) => `${i + 1}. /${c.id}: ${c.summary} ${state(c)}.`).join(' ')}`
    + `${shown.length > 1 || readiness ? ` Of these ${shown.length}: ${tally}.` : ''} Say a number to hear one, or "run" and its name. Nothing was run.`;
}

// ─── Contextual suggestions ───────────────────────────────────────────────

// Common owner goals → the commands that serve them, in execution order.
// Deterministic; only real catalog ids (checked by the tests).
export const SUGGESTION_RULES = Object.freeze([
  { id: 'website-clients', label: 'Find and win website clients',
    when: /\b(?:money|income|earn|clients?|business|side hustle|customers?)\b[\s\S]{0,60}\b(?:websites?|web design|web sites?|landing pages?)\b|\b(?:websites?|web design)\b[\s\S]{0,60}\b(?:money|income|earn|clients?|customers?|sell)\b/i,
    commands: ['lead-scout', 'lead-audit', 'pricing', 'lead-proposal'] },
  { id: 'faceless-youtube', label: 'Make a faceless YouTube video',
    when: /\b(?:faceless|youtube|yt)\b[\s\S]{0,60}\b(?:videos?|channel|shorts?|content)\b|\b(?:videos?|channel)\b[\s\S]{0,40}\b(?:youtube|faceless)\b/i,
    commands: ['yt-ideas', 'yt-script', 'yt-video', 'yt-thumbnail'] },
  { id: 'build-app', label: 'Plan, build and review an app',
    when: /\b(?:build|make|create|develop)\b[\s\S]{0,40}\b(?:app|application|booking (?:system|tool)|web app|tool)\b/i,
    commands: ['che-plan', 'app-build', 'code-review'] },
  { id: 'nq-open', label: 'NQ open briefing with risk check',
    when: /\b(?:nq|mnq|nasdaq futures|es futures|futures)\b[\s\S]{0,60}\b(?:open|today|doing|setup|levels?|trade)\b|\b(?:market|new york) open\b/i,
    commands: ['trade-open', 'trade-chart', 'trade-risk'] },
  { id: 'build-website', label: 'Build and publish a website',
    when: /\b(?:build|make|create|need)\b[\s\S]{0,30}\b(?:a |an |my )?(?:website|site|landing page)\b/i,
    commands: ['site-build', 'site-audit', 'site-publish'] },
  { id: 'money-plan', label: 'Get a grip on your money',
    when: /\b(?:budget|cash ?flow|expenses?|spending|save money|savings|my finances|bills)\b/i,
    commands: ['cashflow', 'budget', 'money-forecast'] },
  { id: 'pricing', label: 'Price your service',
    when: /\bhow much (?:should|do|can) i charge\b|\b(?:pricing|price) (?:for|my)\b/i,
    commands: ['pricing', 'lead-proposal'] },
  { id: 'launch', label: 'Launch and market a business',
    when: /\b(?:start|launch|open)\b[\s\S]{0,30}\b(?:a |my )?(?:business|brand|company|store|shop)\b/i,
    commands: ['business-launch', 'brand-build', 'marketing-plan'] },
  { id: 'social', label: 'Grow on social media',
    when: /\b(?:instagram|tiktok|social media|facebook page|followers)\b/i,
    commands: ['social-content', 'marketing-plan'] },
  { id: 'backtest', label: 'Test a trading strategy',
    when: /\b(?:test|backtest|does this strategy|strategy work)\b[\s\S]{0,40}\b(?:strategy|trading|setup)\b/i,
    commands: ['trade-backtest', 'trade-journal'] },
  { id: 'verify', label: 'Check that this is true',
    when: /\b(?:is (?:it|that|this) true|fact[- ]?check|verify|is this legit|scam)\b/i,
    commands: ['che-verify', 'che-research'] },
  { id: 'office', label: 'Hand it to the Office crew',
    when: /\b(?:delegate|have the (?:team|office)|office crew|my agents)\b/i,
    commands: ['office-status', 'office-delegate'] },
]);

const SKIP_SUGGESTIONS = /^\s*(?:\/|yes\b|no\b|ok\b|okay\b|thanks?\b|thank you\b|stop\b|cancel\b|hi\b|hello\b|hey\b)/i;

/**
 * At most `limit` suggestion cards for one owner message. Each card is a
 * combination of real commands with their live status; nothing runs.
 */
export function suggestCommands(message, { connectors = null, limit = 2, exclude = [] } = {}) {
  const text = String(message || '').trim();
  if (text.length < 12 || text.length > 1200 || SKIP_SUGGESTIONS.test(text)) return [];
  if (text.split(/\s+/).length < 3) return [];
  const skip = new Set((exclude || []).map(String));
  const cards = [];
  for (const rule of SUGGESTION_RULES) {
    if (cards.length >= limit) break;
    if (skip.has(rule.id) || !rule.when.test(text)) continue;
    const commands = rule.commands.map((id) => BY_ID.get(id)).filter(Boolean);
    const steps = commands.map((c) => ({
      id: c.id, title: c.title, summary: c.summary, mode: c.mode,
      approval: Boolean(c.confirm),
      status: connectors ? commandStatus(c, connectors).status : 'unknown',
    }));
    // A card whose every step needs setup is still shown (the owner learns
    // what to connect), but never ahead of a card that can run now.
    cards.push({ id: rule.id, label: rule.label, commands: steps, runnable: steps.filter((s) => s.status === 'available').length });
  }
  return cards.sort((a, b) => (b.runnable > 0) - (a.runnable > 0)).slice(0, limit);
}

// ─── Workflows ────────────────────────────────────────────────────────────

const MAX_STEPS = 12;
const cleanName = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

/**
 * Validates a workflow and describes it the way the builder shows it: each
 * step's purpose, inputs (the steps it waits for), what it produces, its
 * connectors, approval checkpoint and status. Never runs anything.
 */
export function describeWorkflow(input = {}, connectors = {}) {
  const name = cleanName(input.name, 80);
  const raw = Array.isArray(input.steps) ? input.steps : [];
  const issues = [];
  if (!name) issues.push('Give the workflow a name.');
  if (!raw.length) issues.push('Add at least one command.');
  if (raw.length > MAX_STEPS) issues.push(`A workflow can have at most ${MAX_STEPS} steps.`);
  const steps = raw.slice(0, MAX_STEPS).map((s, i) => {
    const command = commandById(s?.command);
    const id = `s${i + 1}`;
    if (!command) { issues.push(`Step ${i + 1}: "${cleanName(s?.command, 40)}" is not a CHE command.`); return { id, command: cleanName(s?.command, 40), valid: false }; }
    const text = cleanName(s?.input, 1000);
    // By default a step waits for the one before it. "parallel" makes it
    // share the previous step's prerequisites instead, so both run together.
    const after = i === 0 ? [] : s?.parallel === true ? (raw[i - 1]?.__deps || []) : [`s${i}`];
    s.__deps = after;
    const status = commandStatus(command, connectors);
    if (command.input?.required && !text && i === 0) issues.push(`Step ${i + 1} (/${command.id}) needs: ${command.input.hint}.`);
    if (status.status !== 'available') issues.push(`Step ${i + 1} (/${command.id}) ${STATUS_WORDS[status.status]}: ${status.missing.map((m) => m.label).join(', ')}.`);
    return {
      id, command: command.id, title: command.title, purpose: command.summary, mode: command.mode, input: text,
      depends_on: after, uses: after.map((d) => d), produces: command.produces,
      connectors: command.needs.map((n) => ({ id: n, label: CONNECTORS[n]?.label || n, ready: connectors[n]?.state === 'ready' })),
      approval: command.confirm ? { required: true, reason: command.confirm } : { required: false, reason: '' },
      status: status.status, cost: command.cost, valid: true,
    };
  });
  for (const s of raw) if (s && typeof s === 'object') delete s.__deps;
  return {
    name,
    steps,
    issues,
    ok: issues.length === 0,
    approvals: steps.filter((s) => s.approval?.required).map((s) => s.id),
    runnable: steps.length > 0 && steps.every((s) => s.valid && s.status === 'available'),
  };
}

/** Objective nodes for CHE's existing objective graph (objective_graph.js). */
export function workflowNodes(described) {
  return described.steps.map((s) => {
    const command = commandById(s.command);
    return {
      id: s.id,
      kind: 'command',
      command: command.id,
      title: `/${command.id}${s.input ? ` ${s.input}` : ''}`.slice(0, 100),
      goal: command.summary,
      input: s.input,
      prompt: dispatchPrompt(command, s.input),
      depends_on: s.depends_on,
      needs_approval: Boolean(command.confirm),
      tools: command.needs,
      // Steps in one area (the site, the desk, the Office) never run at the
      // same time; steps in different areas may run in parallel.
      targets: [`area:${command.category}`],
    };
  });
}

/** A saved workflow as stored on the Worker (owner preference data). */
export function normalizeSavedWorkflow(input = {}, now = new Date().toISOString()) {
  const name = cleanName(input.name, 80);
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, MAX_STEPS)
    .map((s) => ({ command: commandById(s?.command)?.id || '', input: cleanName(s?.input, 1000), parallel: s?.parallel === true }))
    .filter((s) => s.command);
  if (!name || !steps.length) return null;
  const id = cleanName(input.id, 40).replace(/[^\w-]/g, '') || `wf-${crypto.randomUUID().slice(0, 8)}`;
  return { id, name, steps, created_at: cleanName(input.created_at, 40) || now, updated_at: now };
}

/** "run my client workflow" → the saved workflow it names, if any. */
export function findSavedWorkflow(saved = [], message = '') {
  const m = /\b(?:run|start|launch)\s+(?:my\s+|the\s+)?(.{2,80}?)\s+workflow\b/i.exec(String(message || ''));
  if (!m) return null;
  const want = m[1].toLowerCase().trim();
  return (saved || []).find((w) => w.name.toLowerCase() === want)
    || (saved || []).find((w) => w.name.toLowerCase().includes(want) || want.includes(w.name.toLowerCase())) || null;
}
