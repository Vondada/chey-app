import assert from 'node:assert/strict';
import test from 'node:test';
import { startGithubVideo, githubVideoStatus, githubVideoFile, githubVideoDiagnosis } from './github_video_renderer.js';
import { generateVideo, readBlob } from './media.js';

const env={ CHE_GITHUB_REPO: 'Vondada/chey-app', CHE_GITHUB_TOKEN: 'test-token' };
const text = value => new TextEncoder().encode(value);
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function concat(chunks) {
  const out=new Uint8Array(chunks.reduce((n,v)=>n+v.length,0)); let pos=0;
  for(const chunk of chunks){out.set(chunk,pos);pos+=chunk.length;} return out;
}
function storedZip(files) {
  const locals=[],central=[]; let offset=0;
  for(const [name,content] of Object.entries(files)) {
    const path=text(name),data=content instanceof Uint8Array?content:text(content);
    const local=new Uint8Array(30+path.length), lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true); lv.setUint16(8,0,true); lv.setUint32(18,data.length,true);
    lv.setUint32(22,data.length,true); lv.setUint16(26,path.length,true);
    local.set(path,30);
    const dir=new Uint8Array(46+path.length), cv=new DataView(dir.buffer);
    cv.setUint32(0,0x02014b50,true); cv.setUint16(10,0,true);
    cv.setUint32(20,data.length,true); cv.setUint32(24,data.length,true);
    cv.setUint16(28,path.length,true); cv.setUint32(42,offset,true);
    dir.set(path,46);
    locals.push(local,data);central.push(dir);offset+=local.length+data.length;
  }
  const directory=concat(central),end=new Uint8Array(22),v=new DataView(end.buffer);
  v.setUint32(0,0x06054b50,true);v.setUint16(8,central.length,true);
  v.setUint16(10,central.length,true);v.setUint32(12,directory.length,true);
  v.setUint32(16,offset,true);
  return concat([...locals,directory,end]);
}
// A minimal real MP4 layout: ftyp, then moov with a 15-second movie header
// and H.264 + AAC sample entries.
function box(type, ...parts) {
  const payload = concat(parts.map((p) => (p instanceof Uint8Array ? p : text(p))));
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length); out.set(text(type), 4); out.set(payload, 8);
  return out;
}
function mvhd(seconds, scale = 1000) {
  const body = new Uint8Array(100); const v = new DataView(body.buffer);
  v.setUint32(12, scale); v.setUint32(16, Math.round(seconds * scale));
  return box('mvhd', body);
}
function mp4(seconds = 15, codecs = 'avc1 mp4a') {
  return concat([box('ftyp', 'isom', new Uint8Array(4)), box('moov', mvhd(seconds), box('trak', box('stsd', codecs)))]);
}
const video=mp4();
const png=new Uint8Array(32);
png.set([137,80,78,71,13,10,26,10],0);
new DataView(png.buffer).setUint32(16,1280);
new DataView(png.buffer).setUint32(20,720);
const manifest={
  status:'verified',duration_seconds:15,video_width:720,video_height:1280,
  title:'3 SPACE FACTS',description:'Test narration',youtube_uploaded:false,
};
const zip=storedZip({'video.mp4':video,'thumbnail.png':png,'manifest.json':JSON.stringify(manifest)});

test('free renderer dispatches exactly one workflow and does not upload to YouTube',async()=>{
  const requests=[];
  const started=await startGithubVideo(env,'Three facts about space',15,async (url, options)=>{
    requests.push({url:String(url),options});return new Response(null,{status:204});
  });
  assert.equal(started.ok,true);
  assert.equal(started.pending,true);
  assert.match(started.task_id,/^gha_[a-f0-9]{32}$/);
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/che-video-render.yml\/dispatches$/);
  assert.equal(JSON.parse(requests[0].options.body).inputs.seconds,'15');
  assert.equal(requests[0].url.includes('youtube'),false);
});

test('GitHub artifact job is verified by reading real stored archive entries',async()=>{
  const id='gha_'+'c'.repeat(32);
  const fetcher=async url=>{
    const u=String(url);
    if(u.includes('/workflows/')&&u.includes('/runs?'))return json({workflow_runs:[{display_title:'CHE free render '+id,status:'completed',conclusion:'success',id:56}]});
    if(u.includes('/runs/56/artifacts'))return json({artifacts:[{name:'che-video-'+id,id:77,expired:false}]});
    if(u.includes('/artifacts/77/zip'))return new Response(zip);
    throw Error('Unexpected GitHub call: '+u);
  };
  const result=await githubVideoStatus(env,id,fetcher);
  assert.equal(result.ok,true);
  assert.equal(result.verified,true);
  assert.equal(result.duration_seconds,15);
  assert.equal(result.artifact_id,77);
  assert.equal(result.thumbnail_width,1280);
  assert.deepEqual(await githubVideoFile(env,77,'video.mp4',fetcher),video);
  assert.deepEqual(await githubVideoFile(env,77,'thumbnail.png',fetcher),png);
});

test('GitHub media records are made only after render and artifact verification',async()=>{
  const data=new Map();
  const storage={get:async key=>data.get(key),put:async(key,value)=>data.set(key,value)};
  let id='',dispatches=0;
  const fetcher=async(url,options)=>{
    const u=String(url);
    if(u.endsWith('/dispatches')){
      dispatches++;id=JSON.parse(options.body).inputs.job_id;
      return new Response(null,{status:204});
    }
    if(u.includes('/workflows/')&&u.includes('/runs?'))return json({workflow_runs:[{display_title:'CHE free render '+id,status:'completed',conclusion:'success',id:56}]});
    if(u.includes('/runs/56/artifacts'))return json({artifacts:[{name:'che-video-'+id,id:77,expired:false}]});
    if(u.includes('/artifacts/77/zip'))return new Response(zip);
    throw Error('Unexpected GitHub call: '+u);
  };
  const started=await generateVideo(env,storage,{prompt:'Three facts about space',seconds:15,thumbnail:true},fetcher);
  assert.equal(started.status,202);
  assert.equal(started.job_id,id);
  assert.equal(data.has('media_index'),false);
  const result=await generateVideo(env,storage,{task_id:id,prompt:'Three facts about space'},fetcher);
  assert.equal(result.status,200);
  assert.equal(result.item.verified,true);
  assert.equal(result.item.duration_verified,true);
  assert.ok(result.item.thumbnail_media_id);
  assert.equal(result.item.blob,'github-artifact');
  assert.equal(dispatches,1,'finalize must not re-render');
  const found=await storage.get('media_index');
  assert.equal(found.length,2);
  const again=await generateVideo(env,storage,{task_id:id,prompt:'Three facts about space'},fetcher);
  assert.equal(again.duplicate,true);
  assert.equal(again.item.id,result.item.id);
  assert.equal(dispatches,1);
});
test('missing GitHub Actions permission or renderer fails without fake previews',async()=>{
  const denied=await startGithubVideo(env,'Three facts about space',15,async()=>new Response('{}',{status:403}));
  assert.equal(denied.ok,false);
  assert.match(denied.error,/needs Actions: write \(workflow\) or Contents: write \(repository event\)/);
  assert.equal(denied.media_url,undefined);
  const missing=await startGithubVideo({},'Space video',15,async()=>{throw Error('must not call')});
  assert.equal(missing.ok,false);
});

test('voice screen polling finalizes a GitHub render and returns paired preview URLs',async()=>{
  const { handleVideoLine } = await import('./video_route.js');
  const id='gha_'+'d'.repeat(32);
  const records=new Map();
  const storage={get:async key=>records.get(key),put:async(key,val)=>records.set(key,val)};
  const fetcher=async url=>{
    const u=String(url);
    if(u.includes('/workflows/')&&u.includes('/runs?'))return json({
      workflow_runs:[{display_title:'CHE free render '+id,status:'completed',conclusion:'success',id:56}]
    });
    if(u.includes('/runs/56/artifacts'))return json({artifacts:[{name:'che-video-'+id,id:77,expired:false}]});
    if(u.includes('/artifacts/77/zip'))return new Response(zip);
    throw Error('Unexpected API '+u);
  };
  const req=new Request('https://che.example/api/video/line?task_id='+id);
  const response=await handleVideoLine(req,env,null,{},storage,fetcher);
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.verified,true);
  assert.equal(body.duration_verified,true);
  assert.match(body.media_url,/^https:\/\/che\.example\/api\/media\/[a-f0-9-]+\/video$/);
  assert.match(body.thumbnail_url,/^https:\/\/che\.example\/api\/media\/[a-f0-9-]+\/image$/);
  assert.equal((await storage.get('media_index')).length,2);
  const twice=await handleVideoLine(req,env,null,{},storage,fetcher);
  assert.equal((await twice.json()).media_id,body.media_id,'a repeated poll reuses stored receipt');
});

test('workflow HTTP 403 falls back to Contents-write repository dispatch without a paid provider',async()=>{
  const calls=[];
  const result=await startGithubVideo(env,'Three facts about space',15,async(url,options)=>{
    calls.push({url:String(url),body:JSON.parse(options.body)});
    return new Response(null,{status:String(url).endsWith('/dispatches') && !String(url).includes('/workflows/') ? 204 : 403});
  });
  assert.equal(result.ok,true);
  assert.equal(result.pending,true);
  assert.equal(result.dispatch_method,'repository_dispatch');
  assert.equal(calls.length,2);
  assert.equal(calls[1].url,'https://api.github.com/repos/Vondada/chey-app/dispatches');
  assert.equal(calls[1].body.event_type,'che_video_render');
  assert.equal(calls[1].body.client_payload.job_id,result.task_id);
  assert.equal(calls[1].body.client_payload.seconds,'15');
});

test('a workflow-dispatch success does not issue a duplicate repository dispatch',async()=>{
  let requests=0;
  const result=await startGithubVideo(env,'Space facts',15,async()=>{requests++;return new Response(null,{status:204});});
  assert.equal(result.ok,true);
  assert.equal(requests,1);
});

test('repository_dispatch runs remain discoverable without workflow_dispatch-only filtering',async()=>{
  const id='gha_'+'e'.repeat(32);
  const urls=[];
  const outcome=await githubVideoStatus(env,id,async(url)=>{
    urls.push(String(url));
    return json({workflow_runs:[{display_title:'CHE free render '+id,status:'queued'}]});
  });
  assert.equal(outcome.pending,true);
  assert.equal(outcome.stage,'queued');
  assert.ok(urls[0].endsWith('/runs?per_page=100'));
});

test('a GitHub rate limit (403 or 429) is a pause, not a missing permission', async () => {
  const limited = [
    new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    new Response('{"message":"You have exceeded a secondary rate limit."}', { status: 403 }),
    new Response('{}', { status: 403, headers: { 'retry-after': '60' } }),
    new Response('{}', { status: 429 }),
  ];
  for (const reply of limited) {
    const status = await githubVideoStatus(env, 'gha_' + 'a'.repeat(32), async () => reply.clone());
    assert.equal(status.ok, true, 'the task is kept');
    assert.equal(status.stage, 'checking');
  }
  const forbidden = await githubVideoStatus(env, 'gha_' + 'a'.repeat(32), async () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 }));
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, 'forbidden');

  // A rate-limited dispatch is not retried through the fallback, and is not
  // blamed on the token's permissions.
  const calls = [];
  const started = await startGithubVideo(env, 'space facts', 15, async (url) => {
    calls.push(String(url));
    return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
  });
  assert.equal(calls.length, 1);
  assert.equal(started.code, 'rate_limited');
  assert.equal(started.retryable, true);
  assert.doesNotMatch(started.error, /lacks the permission|Actions:write/);
});

test('GitHub\'s own refusal is reported as itself, with nothing secret in it', async () => {
  const token = 'github_pat_' + 'A1b2C3d4'.repeat(8);
  const secretEnv = { ...env, CHE_GITHUB_TOKEN: token };
  // The production failure: no User-Agent, so GitHub refused both dispatches.
  const noAgent = () => new Response(JSON.stringify({ message: 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header' }), { status: 403 });
  const rejected = await startGithubVideo(secretEnv, 'black holes', 15, async () => noAgent());
  assert.equal(rejected.code, 'request_rejected');
  assert.match(rejected.error, /no User-Agent header\. This is a CHE defect, not your token/);
  assert.doesNotMatch(rejected.error, /Owner action/);
  // A refusal that echoes the token never repeats it.
  const echoed = await startGithubVideo(secretEnv, 'black holes', 15, async () => new Response(JSON.stringify({ message: `Bad credentials for ${token}` }), { status: 422 }));
  assert.doesNotMatch(JSON.stringify(echoed), /A1b2C3d4/);
  assert.match(echoed.error, /\[hidden\]/);
  // Every call names CHE and never sends the token anywhere but GitHub.
  const seen = [];
  await startGithubVideo(secretEnv, 'black holes', 15, async (url, init) => { seen.push([String(url), new Headers(init.headers)]); return new Response(null, { status: 204 }); });
  assert.equal(seen[0][1].get('user-agent'), 'CHE-Video-Renderer');
});

test('the artifact link GitHub redirects to is fetched without the GitHub token', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    if (String(url).endsWith('/zip')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/signed?sig=1' } });
    if (String(url).startsWith('https://storage.example/')) return new Response(zip);
    throw new Error('unexpected ' + url);
  };
  const bytes = await githubVideoFile(env, 77, 'video.mp4', fetcher);
  assert.equal(bytes.length, video.length);
  assert.equal(calls[1].url, 'https://storage.example/signed?sig=1');
  assert.equal(calls[1].auth, null, 'the token never leaves GitHub');
});

test('the diagnosis says what GitHub says, read-only, with no token value', async () => {
  const token = 'github_pat_' + 'Z9y8X7w6'.repeat(8);
  const seen = [];
  const fetcher = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || 'GET' });
    const h = { 'github-authentication-token-expiration': '2027-01-15 00:00:00 UTC', 'x-github-request-id': 'R1' };
    if (String(url).endsWith('/repos/Vondada/chey-app')) return new Response(JSON.stringify({ full_name: 'Vondada/chey-app', default_branch: 'main' }), { headers: h });
    if (String(url).endsWith('/user')) return new Response(JSON.stringify({ login: 'Vondada' }), { headers: h });
    if (String(url).endsWith('/che-video-render.yml')) return new Response(JSON.stringify({ state: 'disabled_manually', path: '.github/workflows/che-video-render.yml' }), { headers: h });
    return new Response(JSON.stringify({ resources: { core: { remaining: 4990 } } }), { headers: h });
  };
  const report = await githubVideoDiagnosis({ ...env, CHE_GITHUB_TOKEN: token }, fetcher, { source: 'worker_secret' });
  assert.equal(report.token_kind, 'fine-grained personal access token');
  assert.equal(report.token_source, 'worker_secret');
  assert.equal(report.token_expires, '2027-01-15 00:00:00 UTC');
  assert.equal(report.checks.find((c) => c.name === 'user').login, 'Vondada');
  assert.match(report.verdict, /disabled_manually on GitHub\. Owner action: enable it under Actions/);
  assert.ok(seen.every((c) => c.method === 'GET'), 'nothing is dispatched');
  assert.doesNotMatch(JSON.stringify(report), /Z9y8X7w6/);
});

test('the renderer status check also names CHE, so GitHub answers it', async () => {
  const { probeVideoEngine } = await import('./video_engine.js');
  const seen = [];
  const status = await probeVideoEngine(env, async (url, init = {}) => {
    const headers = new Headers(init.headers);
    seen.push(headers.get('user-agent'));
    return headers.get('user-agent') ? new Response('{"state":"active"}') : new Response('{}', { status: 403 });
  });
  assert.deepEqual(seen, ['CHE-Video-Renderer']);
  assert.equal(status.ready, true);
});
