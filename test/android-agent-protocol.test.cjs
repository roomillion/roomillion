"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path");
const protocol=fs.readFile(path.join(__dirname,"../android/app/src/main/agent/protocol.js"),"utf8").then(code=>import("data:text/javascript;base64,"+Buffer.from(code).toString("base64")));
const answer=content=>({role:"assistant",content,api:"openai-completions",provider:"test",model:"test",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:content.some(x=>x.type==="toolCall")?"toolUse":"stop",timestamp:Date.now()});
test("Android Pi transport preserves source tool calls and results across multiple adjustments",async()=>{
  const {Agent}=await import("@earendil-works/pi-agent-core"),{AssistantMessageEventStream}=await import("@earendil-works/pi-ai/utils/event-stream");
  const {toOpenAiMessages}=await protocol;let revision=0,requests=[];
  const agent=new Agent({initialState:{systemPrompt:"修改当前房间",model:{id:"test",api:"openai-completions",provider:"test"},tools:[{name:"patch_file",description:"修改",parameters:{type:"object",properties:{revision:{type:"integer"}},required:["revision"]},execute:async(id,args)=>{assert.equal(args.revision,revision);return {content:[{type:"text",text:JSON.stringify({revision:++revision})}]};}}]},streamFn:(model,context)=>{
    const messages=toOpenAiMessages(context.messages);requests.push(messages);const stream=new AssistantMessageEventStream();
    const result=answer(messages.at(-1).role==="user"?[{type:"toolCall",name:"patch_file",id:"edit_"+revision,arguments:{revision}}]:[{type:"text",text:"完成"}]);
    stream.push({type:"done",reason:result.stopReason,message:result});stream.end(result);return stream;
  }});
  await agent.prompt("增加搜索");await agent.prompt("再改成模糊搜索");
  assert.equal(revision,2);assert.equal(requests.length,4);assert.equal(requests.at(-1).filter(m=>m.role==="user").length,2);
  assert.equal(requests.at(-1).filter(m=>m.role==="tool").length,2);assert.match(requests[0][0].content,/修改当前房间/);
});
test("Android interrupted transcript recovers unfinished calls without rerunning completed ones",async()=>{
  const {recoverTranscript,toOpenAiMessages}=await protocol,calls=[];
  const messages=[{role:"user",content:"修复"},answer([{type:"toolCall",id:"a",name:"patch_file",arguments:{}},{type:"toolCall",id:"b",name:"test_room",arguments:{}}]),{role:"toolResult",toolCallId:"a",toolName:"patch_file",content:[{type:"text",text:"已写入"}]}, {...answer([]),stopReason:"aborted"}];
  const restored=await recoverTranscript(messages,async c=>{calls.push(c.id);return {passed:true};});
  assert.deepEqual(calls,["b"]);assert.equal(restored.at(-1).toolCallId,"b");assert.equal(toOpenAiMessages(restored).at(-1).role,"tool");
  assert.equal((await recoverTranscript([{role:"assistant",content:"完成"}],()=>assert.fail())).length,1);
});
test("Android interrupted tool failures remain visible to the model",async()=>{
  const {recoverTranscript}=await protocol;
  const restored=await recoverTranscript([answer([{type:"toolCall",id:"fail",name:"patch_file",arguments:{}}])],()=>{throw Error("修订过期");});
  assert.equal(restored.at(-1).isError,true);assert.match(restored.at(-1).content[0].text,/修订过期/);
});
