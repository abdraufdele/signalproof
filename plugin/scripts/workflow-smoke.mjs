import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {createInterface} from "node:readline";
import {performance} from "node:perf_hooks";
import {withProcess} from "./process.mjs";
const root=new URL("../",import.meta.url),artifact=new URL("dist/plugin.mjs",root);
const bytes=await readFile(artifact),hash=createHash("sha256").update(bytes).digest("hex");
const meta={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"signalproof-local-workflow-test",version:"0.6.0"},"io.modelcontextprotocol/clientCapabilities":{}};
async function operation(method,params={}){
 const started=performance.now();
 return withProcess(process.execPath,["--import",new URL("test-broker.mjs",import.meta.url).pathname,artifact.pathname],
 {cwd:new URL("dist/",root).pathname,env:{PATH:process.env.PATH,NODE_ENV:"production",SIGNALPROOF_FIXTURE_CASE:"established_control"}},
 async(child)=>{
  let total=0;child.stdout.on("data",chunk=>{total+=chunk.byteLength;if(total>256*1024)child.kill();});child.stderr.on("data",()=>{});
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method,params:{...params,_meta:meta}})+"\n");
  try{for await(const line of lines){
   const response=JSON.parse(line);
   if(response.id===1){if(response.error)throw Error("MCP error");return {response:response.result,durationMs:Math.round(performance.now()-started),bytes:total};}
  }}finally{lines.close();}
  throw Error("No MCP response");
 },10000);
}
const discovery=await operation("tools/list");
const toolNames=discovery.response.tools.map(t=>t.name);
for(const name of ["inspect_base_token","verify_base_sample","propose_research_purchase"])if(!toolNames.includes(name))throw Error("Missing tool");
const research=await operation("tools/call",{name:"inspect_base_token",arguments:{token:"0x4200000000000000000000000000000000000006",positionUsdc:"500",maxRoundTripDifferencePct:2}});
const result=research.response.structuredContent;
if(research.response.isError||!result.brief?.coverage||result.sampleChecks.length!==result.pools.filter(p=>p.sampleTransactions.length).length||result.verification?.status!=="sample_verified")throw Error("Research workflow failed");
const sample=result.pools.flatMap(p=>p.sampleTransactions)[0];
const verification=await operation("tools/call",{name:"verify_base_sample",arguments:{token:result.token,transactionHash:sample.transactionHash,expectedSender:sample.reportedSender,expectedPool:result.pools[0].pool}});
if(verification.response.structuredContent?.status!=="sample_verified")throw Error("Sample verification failed");
const report={status:"passed",mode:"local compiled MCP artifact with recorded provider responses; not PayBox hosted",artifactSha256:hash,toolNames,
 steps:[{operation:"discover",durationMs:discovery.durationMs},{operation:"position-specific research",durationMs:research.durationMs,briefState:result.brief.state,sourceCount:result.brief.sources.length,selectedSamples:result.brief.coverage.selectedSamples,verifiedSamples:result.brief.coverage.verifiedSamples},{operation:"verify claimed sample",durationMs:verification.durationMs}],
 researchStdoutBytes:research.bytes,paymentStatus:"not_attempted",hostedStatus:"not_run"};
await writeFile(new URL("../../outputs/agent-workflow-local.json",import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
