"use strict";
export function sanitizeTranscript(messages) {
  return messages.filter(m=>!(m.role==="assistant"&&["error","aborted"].includes(m.stopReason))).map(m=>({...m}));
}
export function toOpenAiMessages(messages) {
  return sanitizeTranscript(messages).map(m=>{
    if(m.role==="system")return {role:"system",content:typeof m.content==="string"?m.content:(m.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n")};
    const blocks=Array.isArray(m.content)?m.content:[{type:"text",text:String(m.content||"")}];
    const text=blocks.filter(b=>b.type==="text").map(b=>b.text).join("\n");
    if(m.role==="toolResult")return {role:"tool",tool_call_id:m.toolCallId,content:text};
    if(m.role==="assistant"){const calls=blocks.filter(b=>b.type==="toolCall").map(b=>({id:b.id,type:"function",function:{name:b.name,arguments:JSON.stringify(b.arguments)}}));return {role:"assistant",content:text||null,...(calls.length?{tool_calls:calls}:{})};}
    return {role:"user",content:text};
  });
}
export function toolDeclarations(tools) {return tools.map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters}}));}
export async function recoverTranscript(messages, execute) {
  const result=sanitizeTranscript(messages),completed=new Set(result.filter(m=>m.role==="toolResult").map(m=>m.toolCallId));
  // Completed calls are returned from the native journal. Pending writes are
  // restored to their pre-call checkpoint before being executed again.
  const lastAssistant=[...result].reverse().find(m=>m.role==="assistant");
  for(const c of (Array.isArray(lastAssistant?.content)?lastAssistant.content:[]).filter(b=>b.type==="toolCall")){
    if(completed.has(c.id))continue;
    let value,isError=false;try{value=await execute(c);}catch(e){value={error:e.message};isError=true;}
    result.push({role:"toolResult",toolCallId:c.id,toolName:c.name,content:[{type:"text",text:JSON.stringify(value)}],isError,timestamp:Date.now()});
  }return result;
}
