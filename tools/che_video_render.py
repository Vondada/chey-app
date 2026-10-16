#!/usr/bin/env python3
"""Original faceless video + narration + thumbnail.

Narration uses Fish Audio's expressive model (Drama 3) when the owner set Fish
up (FISH_API_KEY and CHE_FISH_VOICE_ID). Finished narration is cached by text,
model and voice, so the same words are never paid for twice. Without Fish, or
if Fish fails, the free offline Piper voice narrates as before.
"""
import argparse, hashlib, json, os, random, re, shutil, struct, subprocess, sys, urllib.error, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
BOLD='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
REG='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
def font(size, bold=True): return ImageFont.truetype(BOLD if bold else REG, size)
def wrap(d,text,f,maxw):
    lines=[]; cur=''
    for word in text.split():
        trytext=(cur+' '+word).strip()
        if cur and d.textbbox((0,0),trytext,font=f)[2]>maxw:
            lines.append(cur);cur=word
        else:cur=trytext
    if cur:lines.append(cur)
    return lines
def center(d,lines,y,w,f,color):
    for line in lines:
        box=d.textbbox((0,0),line,font=f)
        d.text(((w-box[2]+box[0])/2,y),line,font=f,fill=color)
        y+=box[3]-box[1]+18
    return y
def art(size,seed,index):
    w,h=size
    image=Image.new('RGB',size,(6,10,30));d=ImageDraw.Draw(image)
    for y in range(h):
        f=y/h;d.line(((0,y),(w,y)),fill=(int(6+9*f),int(10+12*f),int(26+30*f)))
    rng=random.Random(seed)
    for i in range(270 if w<1000 else 430):
        x,y=rng.randrange(w),rng.randrange(h);r=rng.choice([1,1,1,2,2,3]);c=rng.randint(120,245)
        d.ellipse((x-r,y-r,x+r,y+r),fill=(c,c,min(255,c+10)))
    x,y=int(w*(.68 if index%2==0 else .32)),int(h*.42)
    radius=int(min(w,h)*.28)
    for rr in range(radius+23,radius-1,-1):
        f=(radius+23-rr)/24
        color=(int(25+38*f),int(70+58*f),int(110+89*f)) if index%2==0 else (int(120+74*f),int(53+46*f),int(70+36*f))
        d.ellipse((x-rr,y-rr,x+rr,y+rr),fill=color)
    return image
def spoken(text):
    # CHE is said "Chay"; the on-screen text keeps "CHE".
    return re.sub(r'\bChe\b', 'Chay', re.sub(r'\bCHE\b', 'Chay', text))
def pack(value):
    """MessagePack, as Fish's official SDKs send the TTS request."""
    if value is None: return b'\xc0'
    if value is True: return b'\xc3'
    if value is False: return b'\xc2'
    if isinstance(value,int):
        if 0<=value<0x80: return bytes([value])
        if -32<=value<0: return struct.pack('>b',value)
        for code,fmt,lo,hi in ((0xcc,'>B',0,0xff),(0xcd,'>H',0,0xffff),(0xce,'>I',0,0xffffffff),
                               (0xd0,'>b',-0x80,0x7f),(0xd1,'>h',-0x8000,0x7fff),(0xd2,'>i',-0x80000000,0x7fffffff)):
            if lo<=value<=hi: return bytes([code])+struct.pack(fmt,value)
        return (b'\xcf'+struct.pack('>Q',value)) if value>0 else (b'\xd3'+struct.pack('>q',value))
    if isinstance(value,float): return b'\xcb'+struct.pack('>d',value)
    if isinstance(value,str):
        data=value.encode('utf-8'); n=len(data)
        head=bytes([0xa0|n]) if n<32 else (b'\xd9'+struct.pack('>B',n) if n<0x100 else (b'\xda'+struct.pack('>H',n) if n<0x10000 else b'\xdb'+struct.pack('>I',n)))
        return head+data
    if isinstance(value,(list,tuple)):
        n=len(value); head=bytes([0x90|n]) if n<16 else (b'\xdc'+struct.pack('>H',n) if n<0x10000 else b'\xdd'+struct.pack('>I',n))
        return head+b''.join(pack(v) for v in value)
    if isinstance(value,dict):
        n=len(value); head=bytes([0x80|n]) if n<16 else (b'\xde'+struct.pack('>H',n) if n<0x10000 else b'\xdf'+struct.pack('>I',n))
        return head+b''.join(pack(k)+pack(v) for k,v in value.items())
    raise TypeError(f'cannot pack {type(value).__name__}')
def fish_reason(body, hidden):
    """Fish's own words for a refusal: short, with the key and voice removed."""
    text=body.decode('utf-8','replace') if isinstance(body,bytes) else str(body)
    try:
        parsed=json.loads(text); picked=parsed.get('message') or parsed.get('detail') or parsed.get('error') or parsed
        text=picked if isinstance(picked,str) else json.dumps(picked)
    except Exception: pass
    for secret in hidden:
        if secret: text=text.replace(secret,'[hidden]')
    return re.sub(r'\s+',' ',re.sub(r'(?i)bearer\s+\S+','Bearer [hidden]',text)).strip()[:160]
def is_mp3(data):
    return data[:3]==b'ID3' or (len(data)>1 and data[0]==0xFF and (data[1]&0xE0)==0xE0)
def prune(cache, keep=100):
    files=sorted(cache.glob('*.mp3'),key=lambda f:f.stat().st_mtime,reverse=True)
    for old in files[keep:]: old.unlink(missing_ok=True)
def fish_narration(text):
    """(path, model, cache) for Fish narration, or None to use Piper.

    Drama 3 first. When Fish says that model cannot be used here (no API credit,
    not on this account), CHE's everyday Fish model narrates instead, so the
    video still has her voice; Piper is the last resort."""
    key=os.environ.get('FISH_API_KEY','').strip()
    voice=os.environ.get('CHE_FISH_VOICE_ID','').strip()
    off=('0','false','no')
    # Fish is a paid service: it narrates only when the owner opts in with the
    # repository variable CHE_FISH_NARRATION=1. By default the free Piper
    # voice narrates, so a free render never spends Fish credit.
    if os.environ.get('CHE_FISH_NARRATION','').strip().lower() not in ('1','true','yes'): return None
    if os.environ.get('CHE_FISH_PREFERRED','1').strip().lower() in off: return None
    if not key or not re.fullmatch(r'[A-Za-z0-9_-]{8,80}',voice): return None
    def setting(name,default):
        value=os.environ.get(name,'').strip() or default
        return value if re.fullmatch(r'[A-Za-z0-9._-]{1,40}',value) else default
    models=[setting('CHE_FISH_EXPRESSIVE_MODEL','drama-3')]
    everyday=setting('CHE_FISH_MODEL','s2.1-pro-free')
    if everyday not in models: models.append(everyday)
    cache=Path(os.environ.get('CHE_NARRATION_CACHE') or Path.home()/'.cache'/'che-narration')
    cache.mkdir(parents=True,exist_ok=True)
    for model in models:
        cached=cache/(hashlib.sha256(json.dumps([model,voice,128,text]).encode()).hexdigest()[:40]+'.mp3')
        if cached.exists() and is_mp3(cached.read_bytes()[:4]):
            cached.touch()
            print(f'CHE narration: reused cached Fish audio ({model}); no new Fish charge')
            return cached,model,'hit'
    for index,model in enumerate(models):
        last=index==len(models)-1
        # The same body as Fish's SDK (TTSConfig defaults), as MessagePack.
        body=pack({'text':text,'chunk_length':200,'format':'mp3','mp3_bitrate':128,'opus_bitrate':32,'references':[],
            'reference_id':voice,'normalize':True,'latency':'normal','top_p':0.7,'temperature':0.7,'max_new_tokens':1024,
            'repetition_penalty':1.2,'min_chunk_length':50,'condition_on_previous_chunks':True,'early_stop_threshold':1.0})
        request=urllib.request.Request('https://api.fish.audio/v1/tts',data=body,method='POST',
            headers={'Authorization':'Bearer '+key,'Content-Type':'application/msgpack','model':model})
        try:
            with urllib.request.urlopen(request,timeout=120) as response: audio=response.read()
        except urllib.error.HTTPError as error:
            reason=fish_reason(error.read()[:400],(key,voice))
            # Only "this model cannot be used here" tries the next model; a bad
            # key, a rate limit or a server error goes straight to Piper.
            blocked=error.code==402 or (error.code in (400,403,404,422) and re.search(r'model|plan|credit|tier|eligib',reason,re.I))
            nxt='trying '+models[index+1] if blocked and not last else 'using Piper'
            print(f'CHE narration: Fish {model} answered HTTP {error.code}: {reason}; {nxt}')
            if blocked and not last: continue
            return None
        except Exception as error:
            print(f'CHE narration: Fish {model} unreachable ({type(error).__name__}); using Piper'); return None
        if not is_mp3(audio):
            print(f'CHE narration: Fish {model} returned no MP3; using Piper'); return None
        cached=cache/(hashlib.sha256(json.dumps([model,voice,128,text]).encode()).hexdigest()[:40]+'.mp3')
        cached.write_bytes(audio); prune(cache)
        print(f'CHE narration: Fish {model} narrated {len(text)} characters')
        return cached,model,'miss'
    return None
def piper_narration(text, out):
    wav=out/'narration.wav'
    subprocess.run([sys.executable,'-m','piper','-m','en_US-kristin-medium','-f',str(wav),'--',text],check=True)
    return wav
def duration_of(path):
    return float(subprocess.check_output(['ffprobe','-v','error','-show_entries',
        'format=duration','-of','default=noprint_wrappers=1:nokey=1',str(path)],text=True).strip())
def render(topic, seconds, out):
    out.mkdir(parents=True,exist_ok=True)
    space='space' in topic.lower() or 'planet' in topic.lower()
    if space:
        facts=[('THE SUN','Contains over 99 percent of the solar system mass.'),
          ('VENUS','Its rotation takes longer than its year.'),
          ('NEUTRON STARS','More mass than the Sun in a city-sized sphere.')]
        narration=("Three surprising space facts! Our Sun holds nearly all the solar system's mass. "
          "Venus spins more slowly than it orbits the Sun. "
          "And neutron stars squeeze the mass of a star into a city-sized sphere.")
        title='3 SPACE FACTS THAT SOUND IMPOSSIBLE'
    else:
        t=topic.strip()[:90]
        facts=[('THE TOPIC',t),('LOOK CLOSER','Explore the important details.'),('LEARN MORE','Follow reliable sources and keep discovering.')]
        narration=f"Discover {t}. Explore the big picture, key ideas, and questions worth asking. Check reliable sources to learn more."
        title=('DISCOVER '+t).upper()
    for i,(heading,detail) in enumerate(facts):
        im=art((720,1280),130+i*31,i);d=ImageDraw.Draw(im)
        d.rounded_rectangle((38,74,682,174),radius=23,fill=(8,30,57),outline=(56,213,240),width=3)
        center(d,[f'FACT {i+1}' if space else f'SCENE {i+1}'],94,720,font(47),(109,239,251))
        d.rounded_rectangle((34,903,686,1191),radius=34,fill=(8,16,36),outline=(72,157,202),width=3)
        y=center(d,wrap(d,heading,font(49),596),937,720,font(49),(255,255,255))
        center(d,wrap(d,detail,font(26,False),592),y+25,720,font(26,False),(199,224,242))
        im.save(out/f'scene{i+1}.png')
    im=art((1280,720),817,1);d=ImageDraw.Draw(im)
    d.rounded_rectangle((33,26,1247,694),radius=33,outline=(67,224,245),width=5)
    d.rounded_rectangle((41,350,1239,688),radius=31,fill=(8,17,40))
    center(d,wrap(d,title,font(79),1140),392,1280,font(79),(255,250,238))
    d.rounded_rectangle((300,55,980,142),radius=21,fill=(20,94,125))
    center(d,['COGNITIVE HORIZON ENGINE'],79,1280,font(29),(221,252,255))
    im.save(out/'thumbnail.png')
    (out/'narration.txt').write_text(narration,encoding='utf-8')
    # Neural speech is mandatory; never fall back to the robotic eSpeak voice.
    # The free Piper voice, or Fish (Drama 3) when the owner opted in.
    voice_provider,voice_model,voice_cache='piper-neural','en_US-kristin-medium','none'
    wav=None
    fish=fish_narration(spoken(narration))
    if fish:
        wav=out/'narration.mp3'; shutil.copyfile(fish[0],wav)
        if duration_of(wav) > seconds * 1.32:
            print('CHE narration: Fish narration is too long for this video; using Piper'); wav=None
        else:
            voice_provider,voice_model,voice_cache='fish-audio',fish[1],fish[2]
    if wav is None: wav=piper_narration(spoken(narration),out)
    spoken_duration=duration_of(wav)
    if spoken_duration > seconds * 1.32:
        raise RuntimeError('Neural narration is too long for the requested video. Shorten the script, do not cut words.')
    command=['ffmpeg','-hide_banner','-loglevel','error','-y']
    for i in range(1,4):command+=['-loop','1','-framerate','24','-t',str(seconds/3),'-i',str(out/f'scene{i}.png')]
    command+=['-i',str(wav)]
    filters=''.join(f'[{i}:v]fps=24,format=yuv420p,setsar=1[v{i}];' for i in range(3))
    # A mild tempo adjustment preserves all spoken words when the neural
    # narration is slightly longer than the video.
    tempo=max(1.0,spoken_duration / max(1.0, seconds - .3))
    filters+='[v0][v1][v2]concat=n=3:v=1:a=0[v];[3:a]atempo='+str(tempo)+',apad,atrim=duration='+str(seconds)+'[a]'
    command+=['-filter_complex',filters,'-map','[v]','-map','[a]','-c:v','libx264','-preset','veryfast','-crf','27','-pix_fmt','yuv420p','-movflags','+faststart','-c:a','aac','-b:a','96k','-t',str(seconds),str(out/'video.mp4')]
    subprocess.run(command,check=True)
    raw=subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_name,width,height','-of','json',str(out/'video.mp4')],text=True)
    check=json.loads(raw);duration=float(check['format']['duration'])
    stream=next(x for x in check['streams'] if x.get('codec_name')=='h264')
    with Image.open(out/'thumbnail.png') as png: thumbsize=png.size
    if abs(duration-seconds)>.3 or (stream['width'],stream['height'])!=(720,1280) or thumbsize!=(1280,720):
        raise RuntimeError('ffprobe/PIL media validation failed')
    if (out/'video.mp4').stat().st_size<20000:raise RuntimeError('MP4 is unexpectedly small')
    manifest={'status':'verified','topic':topic,'title':title,'description':narration,'duration_seconds':duration,
      'video_width':720,'video_height':1280,'thumbnail_width':1280,'thumbnail_height':720,
      'video_bytes':(out/'video.mp4').stat().st_size,'voice_provider':voice_provider,
      'voice_model':voice_model,'voice_cache':voice_cache,'speech_duration_seconds':spoken_duration,
      'paid_media':voice_provider=='fish-audio' and voice_cache=='miss' and 'free' not in voice_model,
      'youtube_uploaded':False}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('CHE_RENDER_VERIFIED '+json.dumps(manifest))
if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--topic',required=True);p.add_argument('--seconds',type=int,default=15)
    p.add_argument('--out',type=Path,default=Path('rendered'))
    a=p.parse_args()
    if not 3<=len(a.topic)<=500 or not 5<=a.seconds<=90:raise SystemExit('Invalid topic or seconds')
    render(a.topic,a.seconds,a.out)
