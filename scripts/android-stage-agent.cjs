"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), esbuild = require("esbuild");
async function main() {
  const root=path.resolve(__dirname,".."), source=path.join(root,"android/app/src/main/agent"), output=path.join(root,"android/app/build/generated/androidAssets/agent");
  await fs.mkdir(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(source,"agent.js")],outfile:path.join(output,"agent.js"),bundle:true,platform:"browser",format:"iife",target:"chrome89",legalComments:"eof",minify:true});
  for(const name of ["index.html","agent.css"])await fs.copyFile(path.join(source,name),path.join(output,name));
  const {ROOM_MODULE_CATALOG}=require("../src/main/room-module-catalog.cjs");
  const moduleDirectories=await fs.readdir(path.join(root,"android/app/build/generated/androidAssets/android-modules"));
  const modules=ROOM_MODULE_CATALOG.filter(m=>moduleDirectories.includes(m.id)).map(m=>({id:m.id,name:m.name,description:m.description,version:m.packageVersion,requires:m.requires,assets:m.assets.map(a=>({url:`/_modules/${m.id}/${a.publicName}`,type:a.type,global:a.global||null}))}));
  await fs.writeFile(path.join(output,"module-api.json"),JSON.stringify(modules));
  // The runtime is now shipped in the APK; register every bundled package license.
  const result=await esbuild.build({entryPoints:[path.join(source,"agent.js")],bundle:true,platform:"browser",format:"iife",target:"chrome89",write:false,metafile:true,logLevel:"silent"});
  const packages=new Set();for(const file of Object.keys(result.metafile.inputs)){const match=file.replaceAll("\\","/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);if(match)packages.add(match[1]);}
  const compliance=path.join(output,"../compliance/agent");await fs.mkdir(compliance,{recursive:true});
  const index=[];
  for(const name of packages){const dir=path.join(root,"node_modules",name),metadata=JSON.parse(await fs.readFile(path.join(dir,"package.json"),"utf8"));
    const registered=path.join(root,"resources/compliance/licenses/npm",name,metadata.version);
    async function find(dir,archive=false){let items;try{items=await fs.readdir(dir,{withFileTypes:true});}catch{return null;}for(const entry of items){if(entry.isFile()&&/(?:^|[-_.])(licen[cs]e|copying)([-_.]|$)/i.test(entry.name))return path.join(dir,entry.name);}if(archive)for(const entry of items){if(entry.isDirectory()&&entry.name!=="node_modules"){const result=await find(path.join(dir,entry.name),true);if(result)return result;}}return null;}
    const license=await find(registered,true)||await find(dir);if(!license)throw Error(`Agent 缺少许可证：${name}`);
    const filename=name.replaceAll("/","_")+"-LICENSE.txt";await fs.copyFile(license,path.join(compliance,filename));index.push({name,version:metadata.version,license:metadata.license,file:filename});
  }await fs.writeFile(path.join(compliance,"index.json"),JSON.stringify(index,null,2));console.log(`ANDROID_AGENT_OK ${packages.size} licensed packages`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});module.exports={main};
