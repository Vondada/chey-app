#!/usr/bin/env python3
"""Original offline faceless video + narration + thumbnail. No paid service."""
import argparse, json, random, subprocess, sys
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
    wav=out/'narration.wav'
    # Neural speech is mandatory for this upgrade; don't silently fall back
    # to the old robotic eSpeak voice and report a fake quality improvement.
    subprocess.run([sys.executable,'-m','piper','-m','en_US-kristin-medium',
        '-f',str(wav),'--',narration],check=True)
    spoken_duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries',
        'format=duration','-of','default=noprint_wrappers=1:nokey=1',str(wav)],text=True).strip())
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
      'video_bytes':(out/'video.mp4').stat().st_size,'voice_provider':'piper-neural',
      'voice_model':'en_US-kristin-medium','speech_duration_seconds':spoken_duration,
      'paid_media':False,'youtube_uploaded':False}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('CHE_RENDER_VERIFIED '+json.dumps(manifest))
if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--topic',required=True);p.add_argument('--seconds',type=int,default=15)
    p.add_argument('--out',type=Path,default=Path('rendered'))
    a=p.parse_args()
    if not 3<=len(a.topic)<=500 or not 5<=a.seconds<=90:raise SystemExit('Invalid topic or seconds')
    render(a.topic,a.seconds,a.out)
