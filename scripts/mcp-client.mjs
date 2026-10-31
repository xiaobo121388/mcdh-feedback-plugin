import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class McpClient {
  constructor(executable, env) {
    this.nextId = 0; this.pending = new Map(); this.buffer = ""; this.errors = "";
    const decoder = new StringDecoder("utf8");
    this.child = spawn(executable, [], { env:{...process.env,...env},windowsHide:true,stdio:["pipe","pipe","pipe"] });
    this.child.stderr.on("data", chunk => { this.errors=(this.errors+chunk).slice(-16384); });
    this.child.stdout.on("data", chunk => {
      this.buffer += decoder.write(chunk);
      for (let index; (index=this.buffer.indexOf("\n")) >= 0;) {
        const line=this.buffer.slice(0,index).trim(); this.buffer=this.buffer.slice(index+1);
        if (!line) continue;
        try {
          const response=JSON.parse(line); const pending=this.pending.get(response.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(response.id); response.error ? pending.reject(new Error(JSON.stringify(response.error))) : pending.resolve(response.result); }
        } catch (error) { this.fail(error); }
      }
    });
    this.child.once("error", error=>this.fail(error));
    this.child.once("exit", code=>this.fail(new Error(`MCP exited (${code})`)));
  }
  fail(error) { for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error)}this.pending.clear(); }
  request(method,params={}) {
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`MCP timed out: ${method}`))},65000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id,method,params})}\n`);
    });
  }
  async initialize() {
    await this.request("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"feedback-isolated-qa",version:"0.1.0"}});
    this.child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})}\n`);
  }
  async call(name,args={}) {
    const result=await this.request("tools/call",{name:`plugin__blockecho.feedback__${name}`,arguments:args});
    if(result.isError)throw new Error(JSON.stringify(result.content));
    return result.structuredContent.result;
  }
  async close() {
    this.child.stdin.end();
    if(this.child.exitCode!==null)return;
    await Promise.race([new Promise(resolve=>this.child.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
    if(this.child.exitCode===null){this.child.kill();await new Promise(resolve=>this.child.once("exit",resolve));}
  }
}
