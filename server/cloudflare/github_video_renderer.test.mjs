import assert from 'node:assert/strict';
import test from 'node:test';
import { startGithubVideo, githubVideoStatus, githubVideoFile } from './github_video_renderer.js';
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
const video=Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);
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
