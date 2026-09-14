"use strict";

const { expandHostModules, getRoomModule } = require("./room-module-catalog.cjs");

const GAME3D_GENRES = Object.freeze(["collector", "maze", "runner"]);
const GAME3D_DIFFICULTIES = Object.freeze(["easy", "normal", "hard"]);
const GAME3D_THEMES = Object.freeze({
  forest: Object.freeze({ background: "#bfe3d0", ground: "#5f8f68", primary: "#f4f0c8", accent: "#ffcc4d", obstacle: "#365c45" }),
  neon: Object.freeze({ background: "#090b24", ground: "#191c45", primary: "#53f5ff", accent: "#ff4fd8", obstacle: "#343879" }),
  sand: Object.freeze({ background: "#efd9a9", ground: "#bd8c55", primary: "#fff0c2", accent: "#39b8a7", obstacle: "#805b3f" }),
  ice: Object.freeze({ background: "#d8f4ff", ground: "#8bc9dc", primary: "#ffffff", accent: "#ff6f91", obstacle: "#4a8fa8" })
});
const GAME3D_HOST_MODULES = Object.freeze(expandHostModules([
  "graphics.three@1",
  "physics.rapier@1",
  "game.input@1",
  "game.audio@1",
  "game.assets@1"
]));

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function cleanText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function isGame3dPrompt(prompt) {
  const text = String(prompt || "");
  const says3d = /(?:\b3d\b|三维|立体|three\.js|webgl)/i.test(text);
  const saysGame = /(?:游戏|闯关|迷宫|跑酷|收集|躲避|game|runner|maze|collector)/i.test(text);
  return says3d && saysGame;
}

function validateGame3dDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("3D 游戏定义必须是对象");
  const name = cleanText(input.name, 60);
  const description = cleanText(input.description, 240);
  const instructions = cleanText(input.instructions, 240) || "使用 WASD 或方向键移动，空格键跳跃，收集全部能量晶体。";
  if (!name) throw new Error("3D 游戏定义缺少名称");
  const genre = GAME3D_GENRES.includes(input.genre) ? input.genre : "collector";
  const difficulty = GAME3D_DIFFICULTIES.includes(input.difficulty) ? input.difficulty : "normal";
  const theme = Object.hasOwn(GAME3D_THEMES, input.theme) ? input.theme : "forest";
  const defaults = difficulty === "easy"
    ? { speed: 5.8, jump: 7.2, obstacles: 7, collectibles: 6, time: 180 }
    : difficulty === "hard"
      ? { speed: 6.8, jump: 7.8, obstacles: 19, collectibles: 12, time: 90 }
      : { speed: 6.2, jump: 7.5, obstacles: 12, collectibles: 8, time: 120 };
  const player = {
    speed: clamp(input.player?.speed, 3.5, 9, defaults.speed),
    jumpForce: clamp(input.player?.jumpForce, 4, 12, defaults.jump)
  };
  const level = {
    size: Math.round(clamp(input.level?.size, 16, 48, 28)),
    obstacleCount: Math.round(clamp(input.level?.obstacleCount, 4, 30, defaults.obstacles)),
    collectibleCount: Math.round(clamp(input.level?.collectibleCount, 3, 20, defaults.collectibles)),
    timeLimitSeconds: Math.round(clamp(input.level?.timeLimitSeconds, 45, 300, defaults.time))
  };
  const seed = cleanText(input.seed, 80) || `${name}-${genre}-${difficulty}`;
  return Object.freeze({
    kind: "game3d",
    name,
    description,
    genre,
    difficulty,
    theme,
    palette: GAME3D_THEMES[theme],
    instructions,
    seed,
    player: Object.freeze(player),
    level: Object.freeze(level),
    hostModules: GAME3D_HOST_MODULES
  });
}

function validateAiGame3dDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("AI 3D 游戏定义必须是 JSON 对象");
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("AI 3D 游戏定义缺少名称");
  if (typeof input.description !== "string" || input.description.trim().length < 4) throw new Error("AI 3D 游戏说明过短");
  if (!GAME3D_GENRES.includes(input.genre)) throw new Error("genre 只能是 collector、maze 或 runner");
  if (!GAME3D_DIFFICULTIES.includes(input.difficulty)) throw new Error("difficulty 只能是 easy、normal 或 hard");
  if (!Object.hasOwn(GAME3D_THEMES, input.theme)) throw new Error("theme 只能是 forest、neon、sand 或 ice");
  if (typeof input.instructions !== "string" || input.instructions.trim().length < 4) throw new Error("AI 3D 游戏缺少操作说明");
  for (const [name, value] of Object.entries({
    "player.speed": input.player?.speed,
    "player.jumpForce": input.player?.jumpForce,
    "level.size": input.level?.size,
    "level.obstacleCount": input.level?.obstacleCount,
    "level.collectibleCount": input.level?.collectibleCount,
    "level.timeLimitSeconds": input.level?.timeLimitSeconds
  })) {
    if (!Number.isFinite(Number(value))) throw new Error(`${name} 必须是数值`);
  }
  return validateGame3dDefinition(input);
}

function evaluateGame3dQuality(definition, prompt) {
  const text = String(prompt || "");
  const checks = {
    hasDescription: definition.description.length >= 4,
    hasInstructions: definition.instructions.length >= 4,
    requestedMaze: !/(?:迷宫|maze)/i.test(text) || definition.genre === "maze",
    requestedRunner: !/(?:跑酷|runner)/i.test(text) || definition.genre === "runner",
    offlineRuntime: GAME3D_HOST_MODULES.every((moduleId) => definition.hostModules.includes(moduleId)),
    boundedLevel: definition.level.obstacleCount <= 30 && definition.level.collectibleCount <= 20
  };
  const names = {
    hasDescription: "游戏说明过短",
    hasInstructions: "缺少操作说明",
    requestedMaze: "明确要求迷宫但 genre 不是 maze",
    requestedRunner: "明确要求跑酷但 genre 不是 runner",
    offlineRuntime: "缺少内置 3D 运行模块",
    boundedLevel: "关卡规模超过第一版安全上限"
  };
  const issues = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => names[key]);
  return Object.freeze({ passed: issues.length === 0, checks: Object.freeze(checks), issues: Object.freeze(issues) });
}

function parseGame3dDefinition(text) {
  if (typeof text !== "string" || text.length > 100_000) throw new Error("3D 游戏定义文件无效");
  const match = text.trim().match(/^window\.GAME_DEFINITION\s*=\s*(\{[\s\S]*\})\s*;?$/);
  if (!match) throw new Error("当前房间不是可安全修改的 3D 游戏房间");
  return validateGame3dDefinition(JSON.parse(match[1]));
}

function moduleScripts() {
  return GAME3D_HOST_MODULES.flatMap((moduleId) => getRoomModule(moduleId).assets
    .filter((asset) => asset.type === "script")
    .map((asset) => `  <script src="/_modules/${moduleId}/${asset.publicName}"></script>`)).join("\n");
}

function generatedGame3dIndexHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>离线 3D 游戏</title><link rel="stylesheet" href="./styles.css"></head>
<body><main id="game"><div id="viewport"></div><header class="hud"><div><p class="eyebrow">智变 · 离线 3D 房间</p><h1 id="title"></h1></div><div class="stats"><span>晶体 <b id="score">0/0</b></span><span>时间 <b id="time">--</b></span></div></header><p id="message" class="message" role="status"></p><button id="pause" class="pause" type="button">暂停</button><section id="overlay" class="overlay"><div class="panel"><span class="badge" id="genre"></span><h2 id="overlayTitle"></h2><p id="description"></p><p id="instructions" class="instructions"></p><button id="start" type="button">开始游戏</button></div></section><div class="touch" aria-label="触屏方向键"><button data-code="ArrowUp">▲</button><div><button data-code="ArrowLeft">◀</button><button data-code="Space">跳</button><button data-code="ArrowRight">▶</button></div><button data-code="ArrowDown">▼</button></div><pre id="fatal" hidden></pre></main>
<script src="./definition.js"></script>
${moduleScripts()}
<script src="./app.js"></script></body></html>`;
}

function generatedGame3dStyles() {
  return `:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#fff;background:#07110e;color-scheme:dark}*{box-sizing:border-box}html,body,#game,#viewport{width:100%;height:100%;margin:0;overflow:hidden}canvas{display:block;width:100%;height:100%}.hud{position:absolute;z-index:3;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:flex-start;padding:20px 24px;pointer-events:none;background:linear-gradient(#07110eb8,transparent)}h1{font-size:22px;margin:2px 0;text-shadow:0 2px 12px #000}.eyebrow{margin:0;color:#b4f5d4;font-size:10px;font-weight:800;letter-spacing:.15em}.stats{display:flex;gap:9px}.stats span,.badge{background:#07110ecc;border:1px solid #ffffff2d;border-radius:999px;padding:8px 12px;font-size:12px;backdrop-filter:blur(8px)}.message{position:absolute;z-index:3;left:50%;top:78px;transform:translateX(-50%);margin:0;padding:7px 12px;border-radius:10px;background:#07110eb8;font-size:12px;min-height:28px}.pause{position:absolute;z-index:4;right:24px;top:70px}.overlay{position:absolute;z-index:6;inset:0;display:grid;place-items:center;background:#06100dcc;backdrop-filter:blur(9px)}.overlay[hidden]{display:none}.panel{width:min(440px,calc(100% - 36px));padding:30px;border:1px solid #ffffff2b;border-radius:24px;background:#13231ee8;box-shadow:0 30px 90px #0008}.panel h2{font-size:30px;margin:15px 0 8px}.panel p{color:#c9d8d1;line-height:1.6}.instructions{padding:12px;border-radius:12px;background:#ffffff0d}button{border:0;border-radius:11px;background:#55d99e;color:#082016;font:inherit;font-weight:800;padding:11px 18px;cursor:pointer}.touch{position:absolute;z-index:4;left:18px;bottom:18px;display:none;place-items:center;gap:5px}.touch div{display:flex;gap:5px}.touch button{width:48px;height:43px;padding:0;background:#07110ebd;color:#fff;border:1px solid #ffffff38;touch-action:none}.touch button[data-code=Space]{width:58px;font-size:12px}#fatal{position:absolute;z-index:10;inset:18px;margin:0;padding:18px;white-space:pre-wrap;color:#ffd4cd;background:#40140ff2;border-radius:14px;overflow:auto}@media(pointer:coarse),(max-width:720px){.touch{display:grid}.hud{padding:15px}.stats{flex-direction:column;gap:4px}.pause{right:15px;top:98px}.message{top:112px}.panel{padding:24px}.panel h2{font-size:25px}}`;
}

function generatedGame3dAppJs() {
  return `(() => {
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
})();`;
}

module.exports = {
  GAME3D_DIFFICULTIES,
  GAME3D_GENRES,
  GAME3D_HOST_MODULES,
  GAME3D_THEMES,
  evaluateGame3dQuality,
  generatedGame3dAppJs,
  generatedGame3dIndexHtml,
  generatedGame3dStyles,
  isGame3dPrompt,
  parseGame3dDefinition,
  validateAiGame3dDefinition,
  validateGame3dDefinition
};
