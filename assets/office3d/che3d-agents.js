/* Shared La Agencia 3D agents: chibi bots that walk, idle, and act. */
(function (global) {
  "use strict";
  if (!global.THREE) return;

  const THREE = global.THREE;

  const C = {
    cream:0xF7ECD9, cream2:0xFFF9EF, terra:0xC96C4A, terraDark:0x99503D,
    teal:0x2FAFA6, tealDark:0x176F6C, mustard:0xE4AE43, coral:0xF47C6C,
    lavender:0x9583C7, blue:0x668FCB, wood:0xC78B61, woodDark:0x845A46,
    leaf:0x4D865D, leaf2:0x78A66A, ink:0x453531, ink2:0x73534A,
    white:0xFFFDF8, gold:0xD6A63F, chrome:0xBFD5D3, blackGlass:0x172327,
    cheSkin:0xC98967, cheHair:0x2B1C1B,
    idle:0x879B91, working:0x2FB4A8, thinking:0xDFAB41,
    celebrating:0xF06E66, blocked:0xD55249, talking:0xE8B04A
  };

  const palettes = [
    {skin:0xB97A5C,hair:0x30221F,outfit:C.blue,accent:C.teal},
    {skin:0xE0A77C,hair:0x6C3D2A,outfit:C.mustard,accent:C.coral},
    {skin:0x80533E,hair:0x171311,outfit:C.lavender,accent:C.teal},
    {skin:0xD6A078,hair:0x3E251E,outfit:C.terra,accent:C.mustard},
    {skin:0x9D6A50,hair:0x201917,outfit:C.teal,accent:C.coral},
    {skin:0xC78D69,hair:0x5A3425,outfit:C.blue,accent:C.mustard}
  ];

  // Original procedural Workshop skins: no copied game character assets.
  const SKIN={deep:0x5B382D,brown:0x80533E,warm:0xB97A5C,tan:0xC98967,golden:0xD6A078,light:0xE0B18D};
  const HAIR={close:0x201917,fade:0x171311,waves:0x2B1C1B,curls:0x30221F,braids:0x211715,locs:0x1A1413,bun:0x3E251E,bald:0x5B382D};
  const EYES={dark:0x201917,brown:0x3C241F,hazel:0x6B532B,green:0x385B45,blue:0x315A78};
  const OUTFIT={che:C.teal,suit:0x26333C,"jacket-red":0xA53D3D,"jacket-teal":C.teal,hoodie:0x59656D,studio:C.lavender,tech:C.blue};

  function mat(color, roughness=.77, metalness=.02, extra={}) {
    return new THREE.MeshStandardMaterial({color,roughness,metalness,...extra});
  }
  function finish(mesh, cast=true, receive=true) {
    mesh.castShadow = cast; mesh.receiveShadow = receive; return mesh;
  }
  function box(w,h,d,material){ return finish(new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material)); }
  function sphere(r,material,sx=1,sy=1,sz=1){
    const m=finish(new THREE.Mesh(new THREE.SphereGeometry(r,22,18),material));
    m.scale.set(sx,sy,sz); return m;
  }
  function cylinder(rt,rb,h,material,sides=20){
    return finish(new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,sides),material));
  }
  function torus(r,tube,material){
    return finish(new THREE.Mesh(new THREE.TorusGeometry(r,tube,8,22),material));
  }

  const M = {
    cream:mat(C.cream2), terra:mat(C.terra), terraDark:mat(C.terraDark),
    teal:mat(C.teal), tealDark:mat(C.tealDark), mustard:mat(C.mustard),
    coral:mat(C.coral), lavender:mat(C.lavender), blue:mat(C.blue),
    wood:mat(C.wood), woodDark:mat(C.woodDark), leaf:mat(C.leaf),
    leaf2:mat(C.leaf2), ink:mat(C.ink), ink2:mat(C.ink2), white:mat(C.white),
    gold:mat(C.gold,.30,.55), chrome:mat(C.chrome,.20,.70),
    blackGlass:mat(C.blackGlass,.18,.38)
  };

  function normalizeStatus(raw) {
    const s=String(raw||"idle").toLowerCase();
    if (["working","building","researching","meeting","talking"].includes(s)) return "working";
    if (["thinking","analyzing","reviewing","synthesizing"].includes(s)) return "thinking";
    if (["celebrating","done","complete","completed"].includes(s)) return "celebrating";
    if (["blocked","waiting","failed","offline"].includes(s)) return "blocked";
    if (s === "speaking" || s === "talking") return "talking";
    return "idle";
  }
  function statusColor(status){
    if (status === "talking" || status === "speaking") return C.talking;
    return C[normalizeStatus(status)] || C.idle;
  }

  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
    ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
    ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
    ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
    ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
  }

  function faceLabelTexture(agent){
    const canvas=document.createElement("canvas"); canvas.width=560; canvas.height=180;
    const ctx=canvas.getContext("2d");
    roundRect(ctx,18,16,524,148,38);
    ctx.fillStyle="rgba(255,250,240,.96)"; ctx.fill();
    ctx.strokeStyle="#E4CBB3"; ctx.lineWidth=5; ctx.stroke();
    ctx.textAlign="left";
    ctx.fillStyle="#453531";
    ctx.font="800 48px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    ctx.fillText(String(agent.name||"Agent").slice(0,18),44,78);
    ctx.fillStyle="#80655C";
    ctx.font="650 25px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    ctx.fillText(String(agent.role||normalizeStatus(agent.status)).slice(0,26),45,119);
    const hex="#"+new THREE.Color(statusColor(agent.status)).getHexString();
    ctx.fillStyle=hex; ctx.beginPath(); ctx.arc(495,83,17,0,Math.PI*2); ctx.fill();
    const tex=new THREE.CanvasTexture(canvas); tex.colorSpace=THREE.SRGBColorSpace; return tex;
  }

  function makeEye(eyeColor=0x2F201D){
    const g=new THREE.Group();
    const white=sphere(.112,M.white,1,1.12,.55);
    const iris=sphere(.060,mat(eyeColor,.35),1,1.08,.46); iris.position.z=.082;
    const catchlight=sphere(.017,M.white,1,1,.38); catchlight.position.set(.018,.02,.113);
    g.add(white,iris,catchlight); return g;
  }

  function chibiBot(agent,index){
    const isChe=String(agent.id).toLowerCase()==="che" || agent.isChe===true;
    const p=palettes[index%palettes.length],look=agent.appearance||{};
    const skin=SKIN[look.skin_tone]||(isChe?C.cheSkin:p.skin);
    const hair=HAIR[look.hair]||(isChe?C.cheHair:p.hair);
    const outfit=OUTFIT[look.outfit]||(isChe?C.teal:p.outfit);
    const skinMat=mat(skin,.83);
    const hairMat=mat(hair,.68);
    const outfitMat=mat(outfit,.70);
    const accentMat=mat(isChe?C.teal:p.accent,.44,.18);
    const g=new THREE.Group();

    g.userData.agentId=String(agent.id);
    g.userData.status=normalizeStatus(agent.status);
    g.userData.baseY=.30;
    g.userData.phase=index*.87 + Math.random();
    g.userData.isChe=isChe;
    g.userData.mode="idle";
    g.userData.action="chill";
    g.userData.walkSpeed=1.6 + (index%3)*.25;
    g.userData.nextActionAt=0;
    g.userData.home=null;
    g.userData.target=null;
    g.userData.facing=0;

    const shadow=cylinder(.68,.68,.035,new THREE.MeshStandardMaterial({
      color:0x57443E,transparent:true,opacity:.13,roughness:1
    }),32);
    shadow.position.y=.025; g.add(shadow);

    const legMat=isChe?M.tealDark:outfitMat;
    const legL=cylinder(.13,.145,.60,legMat,18); legL.position.set(-.21,.53,0);
    const legR=legL.clone(); legR.position.x=.21;
    const shoeL=sphere(.18,isChe?M.white:M.ink,1.15,.63,1.48); shoeL.position.set(-.21,.20,.08);
    const shoeR=shoeL.clone(); shoeR.position.x=.21;
    g.add(legL,legR,shoeL,shoeR);

    const torso=sphere(.60,isChe?M.white:outfitMat,.88,1.04,.65); torso.position.y=1.26; g.add(torso);
    if(isChe){
      const waist=sphere(.52,M.teal,.92,.46,.64); waist.position.y=1.00; g.add(waist);
      // Gold lapel pin — authoritative Office Boss accent (female avatar preserved)
      const goldLapel=sphere(.07,M.gold,1,1,.55); goldLapel.position.set(-.42,1.38,.38); g.add(goldLapel);
    }

    const coreMat=new THREE.MeshStandardMaterial({
      color:isChe?0x79F5E8:statusColor(agent.status),
      emissive:isChe?0x2FD0C4:statusColor(agent.status),
      emissiveIntensity:.75, roughness:.16, metalness:.35
    });
    const chestCore=sphere(.105,coreMat,1,1,.35); chestCore.position.set(0,1.30,.40); g.add(chestCore);
    const chestRing=torus(.16,.018,M.chrome); chestRing.position.set(0,1.30,.405); g.add(chestRing);

    const armL=new THREE.Group(), armR=new THREE.Group();
    const upperL=cylinder(.115,.125,.66,isChe?skinMat:outfitMat,18); upperL.position.y=-.31;
    const upperR=upperL.clone();
    armL.add(upperL); armR.add(upperR);
    armL.position.set(-.60,1.47,0); armR.position.set(.60,1.47,0);
    armL.rotation.z=-.16; armR.rotation.z=.16;
    const handL=sphere(.13,skinMat); handL.position.y=-.67; armL.add(handL);
    const handR=handL.clone(); armR.add(handR);
    g.add(armL,armR);

    const neck=cylinder(.17,.17,.18,skinMat,18); neck.position.y=1.82; g.add(neck);
    if(isChe){
      const hairBack=sphere(.84,hairMat,1.05,1.28,.68); hairBack.position.set(0,2.47,-.20); g.add(hairBack);
      const longL=sphere(.27,hairMat,.82,2.35,.74); longL.position.set(-.64,2.03,-.05); longL.rotation.z=-.17;
      const longR=longL.clone(); longR.position.x=.64; longR.rotation.z=.17;
      g.add(longL,longR);
    }
    const head=sphere(.76,skinMat,1,1.04,.94); head.position.y=2.42; g.add(head);
    if(isChe){
      const hairTop=sphere(.79,hairMat,1.04,.80,.98); hairTop.position.set(0,2.70,-.08); g.add(hairTop);
    } else {
      const cap=sphere(.77,M.blackGlass,1.02,.38,.96); cap.position.set(0,2.78,-.05); g.add(cap);
      const antenna=cylinder(.025,.025,.26,M.chrome,10); antenna.position.set(.34,3.16,0);
      const antennaTip=sphere(.07,accentMat); antennaTip.position.set(.34,3.31,0);
      g.add(antenna,antennaTip);
    }

    const eyeColor=EYES[look.eyes]||(isChe?0x3C241F:0x23343A);
    const eyeL=makeEye(eyeColor); eyeL.position.set(-.25,2.47,.66);
    const eyeR=makeEye(eyeColor); eyeR.position.set(.25,2.47,.66);
    g.add(eyeL,eyeR);

    const smile=torus(.18,.025,M.ink);
    smile.scale.set(1,.55,1); smile.rotation.x=Math.PI/2; smile.position.set(0,2.22,.69);
    g.add(smile);

    const labelMat=new THREE.SpriteMaterial({map:faceLabelTexture(agent),transparent:true,depthWrite:false});
    const label=new THREE.Sprite(labelMat); label.position.set(0,3.66,0); label.scale.set(2.62,.84,1);
    g.add(label);

    const dotMat=new THREE.MeshStandardMaterial({
      color:statusColor(agent.status), emissive:statusColor(agent.status),
      emissiveIntensity:.55, roughness:.25
    });
    const beacon=sphere(.09,dotMat); beacon.position.set(.66,3.08,.02); g.add(beacon);

    const highlight=new THREE.Mesh(
      new THREE.RingGeometry(0.85,1.05,32),
      new THREE.MeshBasicMaterial({color:0xE8B04A,transparent:true,opacity:0,side:THREE.DoubleSide})
    );
    highlight.rotation.x=-Math.PI/2; highlight.position.y=.04; g.add(highlight);

    g.userData.armL=armL; g.userData.armR=armR; g.userData.legL=legL; g.userData.legR=legR;
    g.userData.coreMat=coreMat; g.userData.label=label; g.userData.labelMat=labelMat;
    g.userData.beaconMat=dotMat; g.userData.highlight=highlight;
    g.userData.eyeL=eyeL; g.userData.eyeR=eyeR;

    if(look.accessory==="glasses"){const gl=torus(.16,.025,M.ink);gl.position.set(-.25,2.47,.72);gl.rotation.x=Math.PI/2;const gr=gl.clone();gr.position.x=.25;g.add(gl,gr);}
    else if(look.accessory==="headset"){const band=torus(.72,.045,M.blackGlass);band.position.set(0,2.52,0);band.rotation.x=Math.PI/2;g.add(band);}
    else if(look.accessory==="chain"){const chain=torus(.31,.025,M.gold);chain.position.set(0,1.52,.43);chain.rotation.x=Math.PI/2;g.add(chain);}
    else if(look.accessory==="hat"){const brim=cylinder(.58,.58,.08,M.blackGlass,28);brim.position.set(0,3.05,.02);g.add(brim);}
    if(["curls","braids","locs","bun"].includes(look.hair)){const extra=sphere(look.hair==="bun"?.34:.72,hairMat,1,look.hair==="locs"?1.15:.55,.9);extra.position.set(0,look.hair==="bun"?3.22:2.88,-.08);g.add(extra);}
    if(look.face==="oval")head.scale.y*=1.10;if(look.face==="square")head.scale.set(1.05,.94,.98);
    if(look.body_type==="compact")g.scale.set(.92,.92,.92);if(look.body_type==="tall")g.scale.set(.96,1.08,.96);
    g.userData.appearance=JSON.stringify(look);
    g.traverse(o=>{ if(o.isMesh || o.isSprite) o.userData.agentRoot=g; });
    return g;
  }

  const ROOM_ACTIONS = {
    office:   { busy:["type","think"], idle:["chill","stretch","look","wander"] },
    warroom:  { busy:["point","talk","listen"], idle:["sit","look","chill"] },
    theater:  { busy:["watch","react"], idle:["watch","chill","look"] },
    art:      { busy:["paint","sculpt"], idle:["look","wander","stretch"] },
    projects: { busy:["huddle","point","type"], idle:["chill","look","wander"] },
    music:    { busy:["jam","mix","nod"], idle:["nod","chill","wander"] }
  };

  function AgentCrowd(opts){
    this.scene = opts.scene;
    this.room = opts.room || "office";
    this.waypoints = opts.waypoints || [];
    this.homes = opts.homes || [];
    this.chars = new Map();
    this.clickRoots = [];
    this._seq = 0;
  }

  AgentCrowd.prototype._pickHome = function(index){
    if (this.homes.length) return this.homes[index % this.homes.length].clone();
    if (this.waypoints.length) return this.waypoints[index % this.waypoints.length].clone();
    return new THREE.Vector3((index%4-1.5)*2.2, .30, (Math.floor(index/4)-1)*2.0);
  };

  AgentCrowd.prototype._pickWander = function(g){
    const pts = this.waypoints.length ? this.waypoints : this.homes;
    if (!pts.length) return g.userData.home.clone();
    let p = pts[Math.floor(Math.random()*pts.length)].clone();
    // Prefer not the exact current spot.
    if (pts.length > 1 && g.position.distanceTo(p) < 0.4) {
      p = pts[Math.floor(Math.random()*pts.length)].clone();
    }
    p.y = g.userData.baseY;
    return p;
  };

  AgentCrowd.prototype._chooseAction = function(g, t){
    const st = g.userData.status || "idle";
    const table = ROOM_ACTIONS[this.room] || ROOM_ACTIONS.office;
    const busy = st === "working" || st === "thinking" || st === "talking" || g.userData.speaking;
    const pool = busy ? table.busy : table.idle;
    const action = pool[Math.floor(Math.random()*pool.length)];
    g.userData.action = action;
    g.userData.nextActionAt = t + 2.5 + Math.random()*4.5;
    if (action === "wander" || (busy && Math.random() < 0.15 && this.room !== "theater" && this.room !== "warroom")) {
      g.userData.mode = "walking";
      g.userData.target = this._pickWander(g);
    } else if (action === "sit" || (this.room === "warroom" || this.room === "theater") && busy) {
      g.userData.mode = "acting";
      if (g.userData.home) g.userData.target = g.userData.home.clone();
    } else if (["type","paint","jam","mix","huddle","point","watch"].includes(action)) {
      g.userData.mode = "acting";
      if (g.userData.home) {
        g.userData.target = g.userData.home.clone();
        if (g.position.distanceTo(g.userData.home) > 0.55) g.userData.mode = "walking";
      }
    } else {
      g.userData.mode = "idle";
    }
  };

  AgentCrowd.prototype.upsert = function(agents){
    if (!Array.isArray(agents)) return;
    const incoming = new Set();
    agents.forEach((raw, index) => {
      if (!raw || raw.id == null) return;
      const agent = {
        id: String(raw.id),
        name: String(raw.name || "Agent"),
        role: String(raw.role || "AI Agent"),
        status: normalizeStatus(raw.status),
        speaking: raw.speaking === true,
        isChe: raw.isChe === true || String(raw.id).toLowerCase() === "che",
        task: String(raw.task || ""),
        appearance: raw.appearance || null
      };
      incoming.add(agent.id);
      let g = this.chars.get(agent.id);
      const lookJson=JSON.stringify(agent.appearance || {});
      if(g && g.userData.appearance!==lookJson){ this.remove(agent.id); g=null; }
      if (!g) {
        g = chibiBot(agent, index);
        const home = this._pickHome(index);
        g.position.copy(home);
        g.userData.home = home.clone();
        g.userData.baseY = home.y;
        g.userData.target = home.clone();
        this.scene.add(g);
        this.chars.set(agent.id, g);
        this.clickRoots.push(g);
      }
      g.userData.status = agent.status;
      g.userData.speaking = agent.speaking;
      g.userData.agentData = agent;
      if (g.userData.beaconMat) {
        const color = statusColor(agent.speaking ? "talking" : agent.status);
        g.userData.beaconMat.color.setHex(color);
        g.userData.beaconMat.emissive.setHex(color);
      }
      if (g.userData.labelMat) {
        if (g.userData.labelMat.map) g.userData.labelMat.map.dispose();
        g.userData.labelMat.map = faceLabelTexture(agent);
        g.userData.labelMat.needsUpdate = true;
      }
      if (g.userData.highlight) {
        g.userData.highlight.material.opacity = agent.speaking ? 0.85 : 0;
      }
      // Keep home index stable when roster order changes slightly.
      if (!g.userData.home) {
        g.userData.home = this._pickHome(index);
      }
    });
    for (const id of Array.from(this.chars.keys())) {
      if (!incoming.has(id)) this.remove(id);
    }
  };

  AgentCrowd.prototype.remove = function(id){
    const g = this.chars.get(id);
    if (!g) return;
    this.scene.remove(g);
    this.chars.delete(id);
    const idx = this.clickRoots.indexOf(g);
    if (idx >= 0) this.clickRoots.splice(idx, 1);
    g.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose && m.dispose());
        else if (o.material.dispose) o.material.dispose();
      }
    });
  };

  AgentCrowd.prototype.tick = function(t, dt){
    this.chars.forEach((g) => {
      const phase = g.userData.phase || 0;
      if (!g.userData.nextActionAt || t >= g.userData.nextActionAt) {
        this._chooseAction(g, t);
      }

      // Locomotion
      const target = g.userData.target;
      if (target && g.userData.mode === "walking") {
        const dx = target.x - g.position.x;
        const dz = target.z - g.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.08) {
          g.position.x = target.x; g.position.z = target.z;
          g.userData.mode = "acting";
        } else {
          const step = Math.min(dist, (g.userData.walkSpeed || 1.6) * dt);
          g.position.x += (dx / dist) * step;
          g.position.z += (dz / dist) * step;
          g.userData.facing = Math.atan2(dx, dz);
          g.rotation.y += (g.userData.facing - g.rotation.y) * 0.18;
        }
      } else if (target && g.userData.mode !== "walking") {
        // Ease back toward home/seat when acting.
        g.position.x += (target.x - g.position.x) * Math.min(1, 4 * dt);
        g.position.z += (target.z - g.position.z) * Math.min(1, 4 * dt);
      }

      const baseY = g.userData.baseY || .30;
      const action = g.userData.action || "chill";
      const st = g.userData.status || "idle";
      let y = baseY + Math.sin(t * 2.0 + phase) * .025;
      const armL = g.userData.armL, armR = g.userData.armR;
      const legL = g.userData.legL, legR = g.userData.legR;
      if (armL && armR) {
        armL.rotation.x = 0; armR.rotation.x = 0;
        armL.rotation.z = -.16; armR.rotation.z = .16;
      }
      if (legL && legR) { legL.rotation.x = 0; legR.rotation.x = 0; }

      if (g.userData.mode === "walking") {
        const swing = Math.sin(t * 9 + phase) * .55;
        if (legL && legR) { legL.rotation.x = swing; legR.rotation.x = -swing; }
        if (armL && armR) { armL.rotation.x = -swing * .8; armR.rotation.x = swing * .8; }
        y = baseY + Math.abs(Math.sin(t * 9 + phase)) * .06;
      } else if (action === "type" || (st === "working" && this.room === "office")) {
        if (armL && armR) {
          armL.rotation.x = .55 + Math.sin(t * 10 + phase) * .12;
          armR.rotation.x = .55 - Math.sin(t * 10 + phase) * .12;
          armL.rotation.z = -.42; armR.rotation.z = .42;
        }
      } else if (action === "paint" || action === "sculpt") {
        if (armR) {
          armR.rotation.z = .95; armR.rotation.x = -0.2 + Math.sin(t * 3 + phase) * .35;
        }
        if (armL) { armL.rotation.z = -.35; armL.rotation.x = .25; }
      } else if (action === "jam" || action === "mix" || action === "nod") {
        g.rotation.y += Math.sin(t * 2.4 + phase) * .01;
        if (armL && armR) {
          armL.rotation.z = -0.9 + Math.sin(t * 5 + phase) * .2;
          armR.rotation.z = 0.9 - Math.sin(t * 5 + phase) * .2;
        }
        y = baseY + Math.abs(Math.sin(t * 5 + phase)) * .05;
      } else if (action === "point" || action === "huddle") {
        if (armR) { armR.rotation.z = 1.15; armR.rotation.x = -.35; }
        if (armL) { armL.rotation.z = -.25; }
        g.rotation.y = (g.userData.facing || 0) + Math.sin(t * .8 + phase) * .05;
      } else if (action === "watch" || action === "listen" || action === "react") {
        g.rotation.y = (g.userData.facing || 0) + Math.sin(t * .6 + phase) * .04;
        if (action === "react" && armR) {
          armR.rotation.z = .7 + Math.sin(t * 2) * .1;
        }
      } else if (action === "talk" || g.userData.speaking) {
        if (armR) { armR.rotation.z = .75; armR.rotation.x = Math.sin(t * 6 + phase) * .15; }
        y = baseY + Math.sin(t * 3 + phase) * .03;
      } else if (action === "stretch") {
        if (armL && armR) {
          armL.rotation.z = -1.2; armR.rotation.z = 1.2;
          armL.rotation.x = -.4; armR.rotation.x = -.4;
        }
      } else if (action === "look") {
        g.rotation.y = (g.userData.facing || 0) + Math.sin(t * .9 + phase) * .25;
      } else if (action === "think" || st === "thinking") {
        if (armR) { armR.rotation.z = .82; armR.rotation.x = -.22; }
      } else if (st === "celebrating" || action === "celebrate") {
        if (armL && armR) {
          armL.rotation.z = -1.05 + Math.sin(t * 4 + phase) * .10;
          armR.rotation.z = 1.05 - Math.sin(t * 4 + phase) * .10;
        }
        y = baseY + .04 + Math.abs(Math.sin(t * 3.5 + phase)) * .10;
      } else if (st === "blocked") {
        if (armL && armR) { armL.rotation.z = -.42; armR.rotation.z = .42; }
        g.rotation.z = Math.sin(t * 1.6 + phase) * .018;
      } else {
        // chill idle
        g.rotation.z = Math.sin(t * 1.1 + phase) * .01;
      }

      // Speak highlight pulse
      if (g.userData.highlight && g.userData.speaking) {
        g.userData.highlight.material.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 4));
        g.userData.highlight.scale.setScalar(1 + 0.08 * Math.sin(t * 4));
      }

      g.position.y = y;
      if (g.userData.coreMat) {
        const pulse = .52 + .32 * (.5 + .5 * Math.sin(t * 3.6 + phase));
        g.userData.coreMat.emissiveIntensity = st === "idle" ? .45 : pulse + .25;
      }
    });
  };

  AgentCrowd.prototype.hitTest = function(raycaster){
    const targets = [];
    this.clickRoots.forEach(g => g.traverse(o => { if (o.isMesh || o.isSprite) targets.push(o); }));
    const hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    return hits[0].object.userData.agentRoot || null;
  };


  /** Cap DPR, prefer cheap shadows — big win on phone GPUs. */
  function tuneRenderer(renderer, opts) {
    opts = opts || {};
    const maxDpr = opts.maxDpr != null ? opts.maxDpr : 1.5;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = opts.shadows !== false;
      // BasicShadowMap is far cheaper than PCFSoft on mobile.
      renderer.shadowMap.type = THREE.BasicShadowMap;
    }
    return renderer;
  }

  function tuneSunShadow(sun, mapSize) {
    const size = mapSize || 1024;
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0006;
    return sun;
  }

  /**
   * Shared rAF loop: FPS cap + pause when tab hidden or Flutter says so.
   * Exposes window.__che3dSetPaused(bool) for the Flutter WebView bridge.
   */
  function frameLoop(tick, opts) {
    opts = opts || {};
    const fps = opts.fps || 24;
    const minDt = 1 / fps;
    const clock = opts.clock || new THREE.Clock();
    let last = 0;
    let paused = false;
    let raf = 0;
    function setPaused(v) {
      paused = !!v;
      if (!paused && !document.hidden && !raf) loop();
    }
    window.__che3dSetPaused = setPaused;
    window.__che3dIsPaused = function () { return paused || document.hidden; };
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // keep paused flag; loop still scheduled but skips work
      } else if (!paused) {
        last = clock.getElapsedTime();
        if (!raf) loop();
      }
    });
    function loop() {
      raf = requestAnimationFrame(loop);
      if (paused || document.hidden) return;
      const t = clock.getElapsedTime();
      const dt = t - last;
      if (dt < minDt) return;
      last = t;
      tick(t, Math.min(0.05, dt || 0.016));
    }
    loop();
    return { setPaused: setPaused, clock: clock };
  }

  global.Che3D = {
    C, M, mat, box, sphere, cylinder, torus, finish,
    normalizeStatus, statusColor, chibiBot, AgentCrowd, ROOM_ACTIONS,
    tuneRenderer, tuneSunShadow, frameLoop
  };
})(window);
