(() => {
  "use strict";
  const definition = window.GAME_DEFINITION;
  const fatal = document.getElementById("fatal");
  const showFatal = (error) => { fatal.hidden = false; fatal.textContent = "3D 房间启动失败：" + (error?.message || error); };
  async function boot() {
    if (!window.THREE || !window.RAPIER || !window.ZhibianInput || !window.ZhibianAudio || !window.ZhibianGameAssets) throw new Error("内置 3D 模块未完整加载");
    if (!window.WebGLRenderingContext) throw new Error("当前设备或显卡驱动不支持 WebGL");
    await window.RAPIER.init();
    const THREE = window.THREE, RAPIER = window.RAPIER, assets = window.ZhibianGameAssets;
    const viewport = document.getElementById("viewport"), overlay = document.getElementById("overlay");
    const title = document.getElementById("title"), overlayTitle = document.getElementById("overlayTitle");
    const message = document.getElementById("message"), scoreText = document.getElementById("score"), timeText = document.getElementById("time");
    document.title = definition.name; title.textContent = definition.name; overlayTitle.textContent = definition.name;
    document.getElementById("description").textContent = definition.description;
    document.getElementById("instructions").textContent = definition.instructions;
    document.getElementById("genre").textContent = ({collector:"收集挑战",maze:"3D 迷宫",runner:"障碍跑酷"})[definition.genre];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(definition.palette.background);
    scene.fog = new THREE.Fog(definition.palette.background, 22, 70);
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 120);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace; viewport.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xdff8ff, 0x30402f, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(9, 18, 7); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = sun.shadow.camera.bottom = -32; sun.shadow.camera.right = sun.shadow.camera.top = 32; scene.add(sun);
    const input = window.ZhibianInput.create(window), audio = window.ZhibianAudio.create();
    const world = new RAPIER.World({ x: 0, y: -18, z: 0 }); world.timestep = 1 / 60;
    const arenaX = definition.genre === "runner" ? 12 : definition.level.size;
    const arenaZ = definition.genre === "runner" ? definition.level.size * 2 : definition.level.size;
    const start = { x: 0, y: 1.1, z: definition.genre === "runner" ? arenaZ / 2 - 3 : arenaZ / 2 - 3.5 };
    const ground = new THREE.Mesh(new THREE.BoxGeometry(arenaX, .3, arenaZ), assets.material(definition.palette.ground)); ground.position.y = -.15; ground.receiveShadow = true; scene.add(ground);
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -.15, 0)); world.createCollider(RAPIER.ColliderDesc.cuboid(arenaX / 2, .15, arenaZ / 2).setFriction(1), groundBody);
    const blocked=[];
    function staticBox(x, y, z, w, h, d, color = definition.palette.obstacle, track = false) { const mesh = assets.obstacle(w, h, d, color); mesh.position.set(x, y, z); scene.add(mesh); const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z)); world.createCollider(RAPIER.ColliderDesc.cuboid(w/2,h/2,d/2).setFriction(.8), body); if(track)blocked.push({x,z,r:Math.hypot(w,d)/2}); return mesh; }
    staticBox(-arenaX/2-.35,1.2,0,.7,2.4,arenaZ+1); staticBox(arenaX/2+.35,1.2,0,.7,2.4,arenaZ+1); staticBox(0,1.2,-arenaZ/2-.35,arenaX+1,2.4,.7); staticBox(0,1.2,arenaZ/2+.35,arenaX+1,2.4,.7);
    let seed = 2166136261; for (const char of definition.seed) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619); const random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const safePosition = (margin = 2, fixedZ = null) => { for (let attempt=0; attempt<80; attempt++) { const x=(random()-.5)*(arenaX-margin*2), z=fixedZ ?? (random()-.5)*(arenaZ-margin*2); if (Math.hypot(x-start.x,z-start.z)>4 && blocked.every((item)=>Math.hypot(x-item.x,z-item.z)>item.r+1.2)) return {x,z}; } return {x:0,z:fixedZ ?? 0}; };
    for (let i=0;i<definition.level.obstacleCount;i++) { let p; if (definition.genre === "maze") { const columns=Math.max(3,Math.floor(arenaX/5)); p={x:((i%columns)/(columns-1)-.5)*(arenaX-5),z:(Math.floor(i/columns)%5/4-.5)*(arenaZ-7)}; } else p=safePosition(2.5); const w=definition.genre === "maze" ? 3.6 : 1.3+random()*2.5, d=definition.genre === "maze" ? .65 : 1.3+random()*2.5, h=1+random()*2.2; staticBox(p.x,h/2,p.z,w,h,d,definition.palette.obstacle,true); }
    const playerMesh = assets.player(definition.palette.primary); scene.add(playerMesh);
    const playerBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(start.x,start.y,start.z).lockRotations().setLinearDamping(1.8).setCcdEnabled(true)); world.createCollider(RAPIER.ColliderDesc.ball(.55).setFriction(.25).setRestitution(0), playerBody);
    const collectibles=[]; for(let i=0;i<definition.level.collectibleCount;i++){const runnerZ=definition.genre==="runner"?arenaZ/2-7-(i/(Math.max(1,definition.level.collectibleCount-1)))*(arenaZ-14):null;const p=safePosition(2,runnerZ); const mesh=assets.collectible(definition.palette.accent); mesh.position.set(p.x,.85,p.z); scene.add(mesh); collectibles.push({mesh,collected:false,phase:random()*Math.PI*2});}
    let collected=0, remaining=definition.level.timeLimitSeconds, running=false, finished=false, last=performance.now();
    function reset(){collected=0;remaining=definition.level.timeLimitSeconds;finished=false;for(const item of collectibles){item.collected=false;item.mesh.visible=true;}playerBody.setTranslation(start,true);playerBody.setLinvel({x:0,y:0,z:0},true);scoreText.textContent=collected+"/"+collectibles.length;timeText.textContent=String(Math.ceil(remaining));message.textContent="收集全部能量晶体";}
    function finish(won){running=false;finished=true;overlay.hidden=false;overlayTitle.textContent=won?"挑战完成！":"时间到了";document.getElementById("description").textContent=won?"你收集了全部 "+collectibles.length+" 枚晶体。":"重新开始，再试一次。";document.getElementById("start").textContent="再玩一次";audio.tone(won?"win":"fail").catch(()=>{});}
    function startGame(){reset();running=true;overlay.hidden=true;last=performance.now();audio.resume().catch(()=>{});}
    document.getElementById("start").addEventListener("click",()=>{if(!finished&&!running&&overlayTitle.textContent==="游戏已暂停"){running=true;overlay.hidden=true;last=performance.now();audio.resume().catch(()=>{});return;}startGame();}); document.getElementById("pause").addEventListener("click",()=>{if(finished||!running)return;running=false;overlay.hidden=false;overlayTitle.textContent="游戏已暂停";document.getElementById("description").textContent="点击继续返回游戏。";document.getElementById("start").textContent="继续";});
    for(const button of document.querySelectorAll("[data-code]")){const code=button.dataset.code; const on=event=>{event.preventDefault();input.setVirtual(code,true);};const off=event=>{event.preventDefault();input.setVirtual(code,false);};button.addEventListener("pointerdown",on);button.addEventListener("pointerup",off);button.addEventListener("pointercancel",off);button.addEventListener("pointerleave",off);}
    function resize(){const width=Math.max(1,viewport.clientWidth),height=Math.max(1,viewport.clientHeight);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();} new ResizeObserver(resize).observe(viewport);resize();
    function frame(now){requestAnimationFrame(frame);const dt=Math.min(.04,(now-last)/1000);last=now;if(running){remaining-=dt;if(remaining<=0){remaining=0;finish(false);}const x=input.axis("KeyA","KeyD")+input.axis("ArrowLeft","ArrowRight"),z=input.axis("KeyW","KeyS")+input.axis("ArrowUp","ArrowDown");const length=Math.hypot(x,z)||1,velocity=playerBody.linvel();playerBody.setLinvel({x:x/length*definition.player.speed,y:velocity.y,z:z/length*definition.player.speed},true);const position=playerBody.translation();if(input.consume("Space")&&position.y<1.2&&Math.abs(velocity.y)<1.2){playerBody.setLinvel({x:velocity.x,y:definition.player.jumpForce,z:velocity.z},true);audio.tone("jump").catch(()=>{});}world.timestep=Math.min(dt,1/30);world.step();const next=playerBody.translation();if(next.y< -5){playerBody.setTranslation(start,true);playerBody.setLinvel({x:0,y:0,z:0},true);}playerMesh.position.set(next.x,next.y,next.z);for(const item of collectibles){if(item.collected)continue;item.mesh.rotation.y+=dt*2.4;item.mesh.position.y=.85+Math.sin(now*.003+item.phase)*.15;if(Math.hypot(next.x-item.mesh.position.x,next.y-item.mesh.position.y,next.z-item.mesh.position.z)<1.05){item.collected=true;item.mesh.visible=false;collected++;scoreText.textContent=collected+"/"+collectibles.length;message.textContent="已收集 "+collected+" 枚晶体";audio.tone("collect").catch(()=>{});if(collected===collectibles.length)finish(true);}}timeText.textContent=String(Math.ceil(remaining));}const p=playerBody.translation();const target=new THREE.Vector3(p.x+8,p.y+8.5,p.z+11);camera.position.lerp(target,.055);camera.lookAt(p.x,p.y,p.z);renderer.render(scene,camera);} reset();requestAnimationFrame(frame);
    globalThis.addEventListener("beforeunload",()=>{input.dispose();audio.dispose();renderer.dispose();world.free();},{once:true});
  }
  boot().catch(showFatal);
})();