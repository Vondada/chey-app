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
def piper_narration(text, out, name='narration.wav'):
    wav=out/name
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
    (out/'captions.srt').write_text(srt([(i*seconds/3,(i+1)*seconds/3,f'{h}. {t}') for i,(h,t) in enumerate(facts)]),encoding='utf-8')
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('CHE_RENDER_VERIFIED '+json.dumps(manifest))
def srt_time(t):
    ms=int(round(max(0.0,t)*1000)); h,ms=divmod(ms,3600000); m,ms=divmod(ms,60000); sec,ms=divmod(ms,1000)
    return f'{h:02}:{m:02}:{sec:02},{ms:03}'
def srt(cues):
    return ''.join(f'{i}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n\n' for i,(a,b,text) in enumerate(cues,1))

# ── Creator Studio storyboard (one episode, vertical) ─────────────────────
# The Worker (creator_studio.js) builds and checks the storyboard; it is
# checked again here, because the renderer draws exactly what it is given:
# still illustrated scenes, burned-in captions and one narrator voice. It is
# not animation and there is no lip sync; the manifest says so.
SPEC_SIZES={(1080,1920),(720,1280)}
SPEC_LOCATIONS={'counter','chalkboard','stoop'}
SPEC_SHOTS={'close-up','two-shot','medium','wide','cutaway-diagram'}
SPEC_KINDS={'story','fact','analogy'}
SPEC_PROPS={'glasses','cap','phone','chalk','tablet'}
SPEC_ID=re.compile(r'[a-z][a-z0-9_-]{0,23}')
SPEC_HEX=re.compile(r'#[0-9A-Fa-f]{6}')
def spec_text(value, limit, what, required=True):
    text=re.sub(r'\s+',' ',re.sub(r'[\x00-\x1f\x7f]',' ',str(value if value is not None else ''))).strip()
    if required and not text: raise ValueError(f'{what} is empty')
    if len(text)>limit: raise ValueError(f'{what} is longer than {limit} characters')
    return text
def spec_box(value, size, what):
    if not (isinstance(value,list) and len(value)==4 and all(isinstance(v,int) for v in value)): raise ValueError(f'{what} is not a box')
    x0,y0,x1,y1=value
    if not (0<=x0<x1<=size[0] and 0<=y0<y1<=size[1]): raise ValueError(f'{what} is outside the frame')
    return value
def validate_spec(raw):
    """A clean copy of the storyboard, or ValueError naming the first problem."""
    if len(raw)>16000: raise ValueError('storyboard is larger than 16000 characters')
    data=json.loads(raw)
    if not isinstance(data,dict) or data.get('v')!=1: raise ValueError('storyboard version is not 1')
    size=(data.get('width'),data.get('height'))
    if size not in SPEC_SIZES: raise ValueError('frame must be 1080x1920 or 720x1280 (9:16)')
    seconds=data.get('seconds')
    if not isinstance(seconds,int) or not 30<=seconds<=45: raise ValueError('an episode lasts 30 to 45 seconds')
    episode=spec_text(data.get('episode'),8,'episode')
    if not re.fullmatch(r'S\d{1,2}E\d{1,3}',episode): raise ValueError('episode must look like S1E1')
    sources={}
    for item in data.get('sources') or []:
        sid=spec_text(item.get('id'),8,'source id')
        if not re.fullmatch(r'S\d{1,2}',sid): raise ValueError('source id must look like S1')
        sources[sid]=spec_text(item.get('label'),60,'source label')
    cast={}
    for member in data.get('cast') or []:
        cid=str(member.get('id',''))
        if not SPEC_ID.fullmatch(cid): raise ValueError('cast id is invalid')
        colors=[member.get(k) for k in ('color','accent','skin')]
        if not all(isinstance(c,str) and SPEC_HEX.fullmatch(c) for c in colors): raise ValueError(f'{cid} colors are invalid')
        if member.get('prop') not in SPEC_PROPS: raise ValueError(f'{cid} prop is invalid')
        cast[cid]={'id':cid,'name':spec_text(member.get('name'),32,'cast name'),'color':colors[0],'accent':colors[1],'skin':colors[2],'prop':member['prop']}
    if not 1<=len(cast)<=8: raise ValueError('the cast has 1 to 8 members')
    layout=data.get('layout') or {}
    boxes={k:spec_box(layout.get(k),size,f'layout {k}') for k in ('badge','headline','diagram','caption')}
    scenes=[]
    for index,scene in enumerate(data.get('scenes') or [],1):
        length=scene.get('seconds')
        if not isinstance(length,int) or not 2<=length<=20: raise ValueError(f'scene {index} lasts 2 to 20 seconds')
        kind,shot,location=scene.get('kind'),scene.get('shot'),scene.get('location')
        if kind not in SPEC_KINDS or shot not in SPEC_SHOTS or location not in SPEC_LOCATIONS: raise ValueError(f'scene {index} kind, shot or location is invalid')
        people=scene.get('cast') or []
        if not (isinstance(people,list) and 1<=len(people)<=3 and all(p in cast for p in people)): raise ValueError(f'scene {index} cast is not in the series cast')
        speaker=scene.get('speaker')
        if speaker not in people: raise ValueError(f'scene {index} speaker is not in the shot')
        cites=scene.get('sources') or []
        if not all(c in sources for c in cites): raise ValueError(f'scene {index} cites a missing source')
        if kind=='fact' and not cites: raise ValueError(f'scene {index} states a fact without a source')
        diagram=scene.get('diagram')
        if diagram is not None:
            if not isinstance(diagram,dict) or diagram.get('type')!='next-word': raise ValueError(f'scene {index} diagram is invalid')
            options=[spec_text(o,16,'diagram word') for o in diagram.get('options') or []]
            if not 2<=len(options)<=4: raise ValueError(f'scene {index} diagram needs 2 to 4 words')
            diagram={'type':'next-word','prompt':spec_text(diagram.get('prompt'),28,'diagram prompt'),'options':options}
        scenes.append({'seconds':length,'kind':kind,'shot':shot,'location':location,'cast':people,'speaker':speaker,
            'caption':spec_text(scene.get('caption'),90,f'scene {index} caption'),
            'narration':spec_text(scene.get('narration'),400,f'scene {index} narration'),'sources':cites,'diagram':diagram})
    if not 3<=len(scenes)<=10: raise ValueError('an episode has 3 to 10 scenes')
    if sum(s['seconds'] for s in scenes)!=seconds: raise ValueError('the scenes do not add up to the episode length')
    return {'v':1,'width':size[0],'height':size[1],'seconds':seconds,'episode':episode,
        'series':spec_text(data.get('series'),60,'series'),'title':spec_text(data.get('title'),100,'title'),
        'description':spec_text(data.get('description'),700,'description'),'sources':sources,'cast':cast,'layout':boxes,'scenes':scenes}
def rgb(value): return tuple(int(value[i:i+2],16) for i in (1,3,5))
def caption_chunks(d,text,f,maxw,lines=2,most=7):
    """The narration as evenly sized caption cards of at most `most` words and `lines` lines."""
    words=text.split(); count=max(1,-(-len(words)//most))
    while True:
        size=-(-len(words)//count)
        chunks=[' '.join(words[i:i+size]) for i in range(0,len(words),size)]
        if size==1 or all(len(wrap(d,c,f,maxw))<=lines for c in chunks): return chunks
        count+=1
def episode_backdrop(size,location):
    w,h=size; s=w/1080
    im=Image.new('RGB',size); d=ImageDraw.Draw(im)
    top,bottom=((18,40,34),(10,22,20)) if location=='chalkboard' else ((40,22,58),(12,14,36))
    for y in range(h):
        f=y/h; d.line(((0,y),(w,y)),fill=tuple(int(a+(b-a)*f) for a,b in zip(top,bottom)))
    if location=='chalkboard':
        d.rounded_rectangle((int(28*s),int(580*s),int(1052*s),int(1010*s)),radius=int(18*s),fill=(26,62,46),outline=(120,84,52),width=int(16*s))
    else:
        # Shelves of phones behind the counter, and a neon frame: no words, so nothing reads under an app's buttons.
        for row in range(3):
            y=int((700+row*110)*s); d.rectangle((int(60*s),y,int(1020*s),y+int(8*s)),fill=(70,50,88))
            for x in range(90,1000,110): d.rounded_rectangle((int(x*s),y-int(70*s),int((x+46)*s),y-int(6*s)),radius=int(8*s),fill=(30,34,60),outline=(90,200,220),width=max(1,int(3*s)))
    if location!='chalkboard':
        d.rectangle((0,int(1000*s),w,h),fill=(58,36,30)); d.rectangle((0,int(1000*s),w,int(1026*s)),fill=(96,62,46))
    else:
        d.rectangle((0,int(1010*s),w,h),fill=(40,30,26))
    return im
def draw_member(d,member,cx,top,s,speaking):
    body,accent,skin=rgb(member['color']),rgb(member['accent']),rgb(member['skin']); ink=(12,12,16)
    if member['prop']=='tablet':
        x0,y0,x1,y1=cx-int(120*s),top+int(150*s),cx+int(120*s),top+int(330*s)
        if speaking: d.rounded_rectangle((x0-int(12*s),y0-int(12*s),x1+int(12*s),y1+int(12*s)),radius=int(30*s),outline=accent,width=int(8*s))
        d.rounded_rectangle((x0,y0,x1,y1),radius=int(22*s),fill=(20,22,30),outline=ink,width=int(6*s))
        d.rounded_rectangle((x0+int(14*s),y0+int(14*s),x1-int(14*s),y1-int(14*s)),radius=int(12*s),fill=body)
        for ex in (-45,45): d.ellipse((cx+int((ex-14)*s),y0+int(50*s),cx+int((ex+14)*s),y0+int(78*s)),fill=ink)
        d.arc((cx-int(50*s),y0+int(70*s),cx+int(50*s),y0+int(140*s)),20,160,fill=ink,width=int(7*s))
        d.line((x0+int(30*s),y0+int(20*s),x0+int(90*s),y1-int(30*s)),fill=(230,240,255),width=max(1,int(3*s)))
        return
    r=int(62*s); hy=top+r
    if speaking: d.ellipse((cx-r-int(14*s),hy-r-int(14*s),cx+r+int(14*s),hy+r+int(14*s)),outline=accent,width=int(8*s))
    for side in (-1,1):
        d.line((cx+side*int(38*s),top+int(400*s),cx+side*int(48*s),top+int(700*s)),fill=ink,width=int(18*s))
        d.ellipse((cx+side*int(48*s)-int(34*s),top+int(684*s),cx+side*int(48*s)+int(34*s),top+int(716*s)),fill=ink)
    d.rounded_rectangle((cx-int(78*s),top+int(140*s),cx+int(78*s),top+int(420*s)),radius=int(34*s),fill=body,outline=ink,width=int(6*s))
    for side in (-1,1):
        d.line((cx+side*int(70*s),top+int(180*s),cx+side*int(132*s),top+int(300*s)),fill=ink,width=int(16*s))
        d.ellipse((cx+side*int(132*s)-int(17*s),top+int(283*s),cx+side*int(132*s)+int(17*s),top+int(317*s)),fill=skin,outline=ink,width=int(4*s))
    d.ellipse((cx-r,hy-r,cx+r,hy+r),fill=skin,outline=ink,width=int(6*s))
    for ex in (-22,22): d.ellipse((cx+int((ex-7)*s),hy-int(14*s),cx+int((ex+7)*s),hy+int(2*s)),fill=ink)
    if speaking: d.ellipse((cx-int(16*s),hy+int(18*s),cx+int(16*s),hy+int(40*s)),fill=ink)
    else: d.arc((cx-int(24*s),hy+int(4*s),cx+int(24*s),hy+int(36*s)),20,160,fill=ink,width=int(5*s))
    prop=member['prop']
    if prop=='glasses':
        for ex in (-22,22): d.ellipse((cx+int((ex-17)*s),hy-int(24*s),cx+int((ex+17)*s),hy+int(10*s)),outline=accent,width=int(5*s))
    elif prop=='cap':
        d.chord((cx-r,hy-r-int(6*s),cx+r,hy+int(10*s)),180,360,fill=accent,outline=ink,width=int(4*s))
        d.rectangle((cx,hy-int(16*s),cx+r+int(30*s),hy-int(4*s)),fill=accent,outline=ink)
    elif prop=='phone':
        hx,hy2=cx+int(132*s),top+int(250*s); d.rounded_rectangle((hx-int(20*s),hy2-int(40*s),hx+int(20*s),hy2+int(30*s)),radius=int(6*s),fill=(20,20,26),outline=accent,width=int(4*s))
    elif prop=='chalk':
        hx,hy2=cx-int(132*s),top+int(280*s); d.rectangle((hx-int(8*s),hy2-int(30*s),hx+int(8*s),hy2),fill=(245,245,240))
def draw_next_word(d,diagram,box,s):
    x0,y0,x1,y1=box; f=font(int(44*s)); small=font(int(28*s),False)
    d.text((x0+int(20*s),y0+int(10*s)),diagram['prompt']+' …',font=f,fill=(240,240,230))
    y=y0+int(90*s)
    for i,word in enumerate(diagram['options']):
        # Bars only show that some next words are likelier than others; no numbers are claimed.
        width=int((x1-x0-int(260*s))*(1-i*0.28))
        d.rounded_rectangle((x0+int(220*s),y,x0+int(220*s)+width,y+int(52*s)),radius=int(10*s),fill=(240,220,120) if i==0 else (150,190,170))
        d.text((x0+int(20*s),y+int(4*s)),word,font=f,fill=(255,255,255))
        y+=int(74*s)
    d.text((x0+int(20*s),y1-int(40*s)),'Illustration: the next word is a guess',font=small,fill=(190,210,200))
def episode_frame(spec,scene,chunk):
    w,h=spec['width'],spec['height']; s=w/1080; lay=spec['layout']
    im=episode_backdrop((w,h),scene['location']); d=ImageDraw.Draw(im)
    people=scene['cast']
    if scene['diagram']:
        draw_next_word(d,scene['diagram'],lay['diagram'],s)
        # The teacher stands beside the board, left of the diagram.
        xs=[int(160*s)+i*int(120*s) for i in range(len(people))]; tops=[int(610*s)]*len(people); scale=0.85
    else:
        xs={1:[540],2:[320,760],3:[190,520,830]}[len(people)]; xs=[int(x*s) for x in xs]
        tops=[int(600*s)]*len(people); scale=1.1 if len(people)<3 else 1.0
    for cid,x,top in zip(people,xs,tops):
        draw_member(d,spec['cast'][cid],x,top,s*scale,cid==scene['speaker'])
    bx0,by0,bx1,by1=lay['badge']; label=scene['kind'].upper()+'  ·  '+spec['episode']
    tone={'story':(240,120,160),'fact':(110,230,170),'analogy':(250,200,90)}[scene['kind']]
    d.rounded_rectangle((bx0,by0,bx0+int(30*s)+d.textbbox((0,0),label,font=font(int(34*s)))[2],by1),radius=int(16*s),fill=(10,12,24),outline=tone,width=int(4*s))
    d.text((bx0+int(15*s),by0+int(14*s)),label,font=font(int(34*s)),fill=tone)
    hx0,hy0,hx1,hy1=lay['headline']
    cite='Source: '+'; '.join(f'{c} {spec["sources"][c]}' for c in scene['sources']) if scene['sources'] else ''
    # Every word of the caption and source is drawn: the type shrinks until it fits its box, never cut.
    for size in (56,50,44,40,36):
        hf,sf=font(int(size*s)),font(int(28*s),False)
        head=wrap(d,scene['caption'],hf,hx1-hx0); foot=wrap(d,cite,sf,hx1-hx0) if cite else []
        if len(head)*int(size*1.2*s)+len(foot)*int(34*s)<=hy1-hy0: break
    else: raise RuntimeError('A scene caption does not fit its caption-safe box. Shorten it.')
    y=hy0
    for line in head:
        d.text((hx0,y),line,font=hf,fill=(255,255,255),stroke_width=int(4*s),stroke_fill=(0,0,0)); y+=int(size*1.2*s)
    for line in foot:
        d.text((hx0,y+int(4*s)),line,font=sf,fill=(200,230,215)); y+=int(34*s)
    cx0,cy0,cx1,cy1=lay['caption']; cf=font(int(54*s))
    d.rounded_rectangle((cx0,cy0,cx1,cy1),radius=int(24*s),fill=(0,0,0))
    lines=wrap(d,chunk,cf,cx1-cx0-int(48*s)); y=cy0+(cy1-cy0-len(lines)*int(66*s))//2
    for line in lines:
        box=d.textbbox((0,0),line,font=cf); d.text((cx0+(cx1-cx0-box[2])//2,y),line,font=cf,fill=(255,236,120)); y+=int(66*s)
    return im
def episode_thumbnail(spec,path):
    im=Image.new('RGB',(1280,720)); d=ImageDraw.Draw(im)
    for y in range(720):
        f=y/720; d.line(((0,y),(1280,y)),fill=(int(40-28*f),int(22-8*f),int(58-22*f)))
    d.rectangle((0,560,1280,720),fill=(58,36,30)); d.rectangle((0,560,1280,580),fill=(96,62,46))
    members=list(spec['cast'].values())[:2]
    for i,member in enumerate(members): draw_member(d,member,170+i*200,110,0.6,i==0)
    d.rounded_rectangle((520,60,1240,140),radius=20,fill=(20,94,125))
    center_line=(spec['series'].upper()+' · '+spec['episode'])
    d.text((545,82),center_line,font=font(30),fill=(221,252,255))
    y=190
    for line in wrap(d,spec['title'].upper(),font(72),680)[:3]:
        d.text((545,y),line,font=font(72),fill=(255,250,238),stroke_width=4,stroke_fill=(0,0,0)); y+=88
    im.save(path)
def scene_voice(text,out,index):
    """One scene's narration: Fish when the owner opted in, otherwise Piper."""
    fish=fish_narration(text)
    if fish:
        path=out/f'scene{index}.mp3'; shutil.copyfile(fish[0],path)
        return path,'fish-audio',fish[1],fish[2]
    return piper_narration(text,out,f'scene{index}.wav'),'piper-neural','en_US-kristin-medium','none'
def render_episode(spec,out):
    out.mkdir(parents=True,exist_ok=True)
    w,h,seconds=spec['width'],spec['height'],spec['seconds']
    measure=ImageDraw.Draw(Image.new('RGB',(8,8))); cf=font(int(54*w/1080))
    lay=spec['layout']; frames=[]; cues=[]; voices=[]; audio=[]; start=0.0
    for index,scene in enumerate(spec['scenes'],1):
        said=spoken(scene['narration']).replace('Ms. ','Miz ')
        path,provider,model,cache=scene_voice(said,out,index)
        spoken_for=duration_of(path); length=scene['seconds']
        # Every word is kept: a scene may be sped up a little, never cut.
        if spoken_for>length*1.25: raise RuntimeError(f'Scene {index} narration is {spoken_for:.1f} s for a {length} s scene. Shorten the script, do not cut words.')
        tempo=max(1.0,spoken_for/max(1.0,length-0.15)); talk=min(length,spoken_for/tempo)
        audio.append((path,tempo,length)); voices.append((provider,model,cache))
        chunks=caption_chunks(measure,scene['narration'],cf,lay['caption'][2]-lay['caption'][0]-int(48*w/1080))
        counts=[len(c.split()) for c in chunks]; total=sum(counts); at=0.0
        # Caption timing is estimated from word counts within the measured speech of the scene.
        for n,(chunk,count) in enumerate(zip(chunks,counts)):
            last=n==len(chunks)-1
            span=(length-at) if last else talk*count/total
            image=out/f'frame{len(frames)+1:03}.png'; episode_frame(spec,scene,chunk).save(image)
            frames.append((image,span)); cues.append((start+at,start+at+(talk*count/total if not last else max(0.5,talk-at)),chunk)); at+=span
        start+=length
    listing=''.join(f"file '{f.name}'\nduration {d:.3f}\n" for f,d in frames)+f"file '{frames[-1][0].name}'\n"
    (out/'frames.txt').write_text(listing,encoding='utf-8')
    command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(out/'frames.txt')]
    for path,_,_ in audio: command+=['-i',str(path)]
    filters=''.join(f'[{i+1}:a]aformat=sample_rates=44100:channel_layouts=mono,atempo={tempo:.4f},apad,atrim=duration={length}[a{i}];' for i,(_,tempo,length) in enumerate(audio))
    filters+=''.join(f'[a{i}]' for i in range(len(audio)))+f'concat=n={len(audio)}:v=0:a=1[a];[0:v]fps=24,format=yuv420p,setsar=1[v]'
    command+=['-filter_complex',filters,'-map','[v]','-map','[a]','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p',
              '-movflags','+faststart','-c:a','aac','-b:a','128k','-t',str(seconds),str(out/'video.mp4')]
    subprocess.run(command,check=True)
    episode_thumbnail(spec,out/'thumbnail.png')
    (out/'captions.srt').write_text(srt(cues),encoding='utf-8')
    raw=subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',str(out/'video.mp4')],text=True)
    check=json.loads(raw); duration=float(check['format']['duration'])
    stream=next((x for x in check['streams'] if x.get('codec_name')=='h264'),None)
    sound=next((x for x in check['streams'] if x.get('codec_type')=='audio'),None)
    with Image.open(out/'thumbnail.png') as png: thumbsize=png.size
    if not stream or not sound or abs(duration-seconds)>.3 or (stream['width'],stream['height'])!=(w,h) or thumbsize!=(1280,720):
        raise RuntimeError('ffprobe/PIL media validation failed')
    if (out/'video.mp4').stat().st_size<20000: raise RuntimeError('MP4 is unexpectedly small')
    providers=sorted({v[0] for v in voices})
    manifest={'status':'verified','topic':spec['title'],'title':spec['title'],'description':spec['description'],
      'duration_seconds':duration,'video_width':w,'video_height':h,'format':'9:16','episode':spec['episode'],'series':spec['series'],
      'thumbnail_width':1280,'thumbnail_height':720,'video_bytes':(out/'video.mp4').stat().st_size,
      'scenes':len(spec['scenes']),'cast':sorted(spec['cast']),'captions':'burned-in and captions.srt','caption_timing':'estimated from word counts',
      'motion':'still illustrated scenes','voices':1,'lip_sync':False,'safe_zone_layout':lay,
      'voice_provider':'+'.join(providers),'voice_model':'+'.join(sorted({v[1] for v in voices})),'voice_cache':'+'.join(sorted({v[2] for v in voices})),
      'paid_media':any(v[0]=='fish-audio' and v[2]=='miss' and 'free' not in v[1] for v in voices),'youtube_uploaded':False}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('CHE_RENDER_VERIFIED '+json.dumps(manifest))
if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--topic',required=True);p.add_argument('--seconds',type=int,default=15)
    p.add_argument('--out',type=Path,default=Path('rendered'))
    # The name of an environment variable holding a Creator Studio storyboard
    # (JSON). Passed by name so the workflow never puts it on a command line.
    p.add_argument('--spec-env',default='')
    a=p.parse_args()
    if not 3<=len(a.topic)<=500 or not 5<=a.seconds<=90:raise SystemExit('Invalid topic or seconds')
    raw=os.environ.get(a.spec_env,'').strip() if a.spec_env else ''
    if raw:
        try: spec=validate_spec(raw)
        except ValueError as error: raise SystemExit(f'Invalid storyboard: {error}')
        if spec['seconds']!=a.seconds: raise SystemExit(f"Storyboard lasts {spec['seconds']} s, not the {a.seconds} s requested")
        render_episode(spec,a.out)
    else:
        render(a.topic,a.seconds,a.out)
