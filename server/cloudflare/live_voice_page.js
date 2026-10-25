// The browser live-voice page served at /live-voice (moved out of worker.js unchanged to keep worker.js within its
// byte budget, tools/che_perf_budget.json). Guarded input, queued chat, provider output ignored: execution_truth.test.mjs.

export function liveVoicePage() {
  const html = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<style>
body{margin:0;background:#08131e;color:#edfafa;font:16px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;min-height:100vh;place-items:center}
main{width:min(88vw,520px);text-align:center}.orb{width:150px;height:150px;margin:20px auto;border-radius:50%;background:radial-gradient(circle at 35% 30%,#b8fff2,#32d9bf 30%,#153a4a 65%,#08131e);box-shadow:0 0 70px #44e1c566}
h1{letter-spacing:.24em;margin:0 0 6px;font-size:28px}.sub{color:#91aaa9;font-size:12px}
button{border:0;border-radius:999px;padding:14px 22px;font-weight:800;background:#67e8d1;color:#07141c;font-size:15px}
#status{margin:18px 0;color:#67e8d1;font-size:13px}.hint{color:#8ca2a4;font-size:12px;line-height:1.45}
</style></head><body><main><div class="orb"></div><h1>CHE</h1><div class="sub">OPENAI REALTIME VOICE</div>
<div id="reply" style="font-size:22px;white-space:pre-wrap"></div><div id="status">Ready</div><button id="start">START LIVE VOICE</button>
<p class="hint">Realtime listening with guarded chat replies. Speak over CHE to stop playback or add a correction.</p></main>
<script>
let pc,dc,stream,audio,turns=Promise.resolve();
const history=[],seen=new Set();
const statusEl=document.getElementById('status'),start=document.getElementById('start');
const ownerToken=()=>new URLSearchParams(location.hash.slice(1)).get('token')||'';
async function answerTurn(message){
  statusEl.textContent='Checking…';
  const headers={Authorization:'Bearer '+ownerToken(),'Content-Type':'application/json'};
  const result=await fetch('/api/chat',{method:'POST',headers,body:JSON.stringify({message,history})});
  const raw=await result.text();
  if(!result.ok)throw new Error('Chat could not complete ('+result.status+'). No success is verified.');
  const frames=raw.split('\\n').filter(Boolean).map(line=>JSON.parse(line));
  const reply=frames.filter(f=>f.type==='delta').map(f=>f.delta).join('');
  history.push({role:'user',content:message},{role:'assistant',content:reply});
  document.getElementById('reply').textContent=reply;
  statusEl.textContent='Listening';
  const voice=await fetch('/api/voice/edge',{method:'POST',headers,body:JSON.stringify({text:reply,purpose:'conversation'})});
  if(voice.ok&&voice.status!==204){
    if(audio.src)URL.revokeObjectURL(audio.src);
    audio.src=URL.createObjectURL(await voice.blob());
    await audio.play();
  }else statusEl.textContent='Reply shown. Voice audio was unavailable.';
}
async function connect(){
  start.disabled=true;statusEl.textContent='Connecting…';
  try{
    const token=ownerToken();if(!token)throw new Error('CHE pairing token missing');
    const tokenRes=await fetch('/api/live/token',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({guarded_output:true})});
    const tokenData=await tokenRes.json();
    if(!tokenRes.ok||tokenData.guarded_output!==true)throw new Error(tokenData.detail||'Guarded live voice is not configured');
    const ephemeral=tokenData.value||tokenData.client_secret?.value;
    if(!ephemeral)throw new Error('No realtime client secret returned');
    pc=new RTCPeerConnection();
    audio=document.createElement('audio');audio.autoplay=true;
    pc.ontrack=e=>{e.track.enabled=false};
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    pc.addTrack(stream.getTracks()[0]);
    dc=pc.createDataChannel('oai-events');
    dc.onopen=()=>{statusEl.textContent='Listening • interrupt anytime';start.textContent='CONNECTED'};
    dc.onmessage=e=>{try{const evt=JSON.parse(e.data);
      if(evt.type==='input_audio_buffer.speech_started'){audio.pause();statusEl.textContent='Listening…'}
      if(evt.type==='conversation.item.input_audio_transcription.completed'&&evt.transcript?.trim()){
        if(evt.item_id&&seen.has(evt.item_id))return;
        if(evt.item_id)seen.add(evt.item_id);
        const message=evt.transcript.trim();
        statusEl.textContent='Turn queued';
        turns=turns.then(()=>answerTurn(message)).catch(err=>{statusEl.textContent=String(err.message||err)});
      }
    }catch(_){}};
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    const sdpRes=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',body:offer.sdp,headers:{Authorization:'Bearer '+ephemeral,'Content-Type':'application/sdp'}});
    if(!sdpRes.ok)throw new Error('OpenAI Realtime connection failed');
    await pc.setRemoteDescription({type:'answer',sdp:await sdpRes.text()});
  }catch(err){statusEl.textContent=String(err.message||err);start.disabled=false;start.textContent='TRY AGAIN'}
}
start.addEventListener('click',connect);
</script></body></html>`;
  return new Response(html,{headers:{
    'Content-Type':'text/html; charset=utf-8',
    'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'self'; connect-src 'self' https://api.openai.com; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; img-src 'self' data:;"
  }});
}
