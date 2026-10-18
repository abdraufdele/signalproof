import {readFile,writeFile,readdir,mkdir} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {assignmentFor} from "./study-design.mjs";
const numeric=value=>{
 if(typeof value==="number")return Number.isFinite(value)?value:null;
 if(typeof value!=="string"||!value.trim())return null;
 const clean=value.trim().replaceAll(",","").replace(/^\$/,"").replace(/%$/,"");
 return /^-?\d+(?:\.\d+)?$/.test(clean)?Number(clean):null;
};
export function expectedAnswers(pack){
 const chosen=pack.records.filter(r=>["highest_reported_liquidity","lowest_positive_liquidity_active"].includes(r.key));
 return new Map(chosen.map(record=>{
  const q=record.rawPacket.prices.find(q=>q.inputUsdc===500),buy=q?.buy?.body,back=q?.sellBack?.body;
  const usdc="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const entry=q?.buy?.httpStatus===200&&buy?.liquidityAvailable===true&&buy?.sellToken?.toLowerCase()===usdc&&buy?.buyToken?.toLowerCase()===record.token.toLowerCase()&&buy?.sellAmount==="500000000";
  const matched=entry&&q?.sellBack?.httpStatus===200&&back?.liquidityAvailable===true&&back.sellAmount===buy.buyAmount&&back?.sellToken?.toLowerCase()===record.token.toLowerCase()&&back?.buyToken?.toLowerCase()===usdc;
  const returned=matched?Number(BigInt(back.buyAmount))/1e6:null;
  return [record.key,{token:record.token,capturedAt:record.capturedAt,route:!entry?"no_entry":matched?"entry_and_reverse":"entry_only",returnedUsdc:returned,differencePct:returned===null?null:(500-returned)/500*100,
   sampledTransactionEstablished:record.report.sampleChecks.some(s=>s.check.status==="sample_verified")}];
 }));
}
export function summarizeResponses(responses,expected){
 const seen=new Set(),accepted=[],excluded=[];
 for(const [index,r]of responses.entries()){
  const code=typeof r?.participantCode==="string"?r.participantCode:"";
  if(r?.mode==="technical_smoke"||r?.technicalOnly||/^(SMOKE|DEMO)/i.test(code)){excluded.push({index,code,reason:"technical_test"});continue;}
  const design=assignmentFor(code,[...expected.keys()].map(key=>({key})));
  const validTask=(task,i)=>{
   const key=expected.get(task?.caseKey),a=task?.answer;
   return key&&task.caseKey===design.queue[i]?.record.key&&task.format===design.queue[i]?.format&&
    task.token?.toLowerCase()===key.token?.toLowerCase()&&task.capturedAt===key.capturedAt&&Number.isFinite(task.durationMs)&&task.durationMs>0&&
    a&&["entry_and_reverse","entry_only","no_entry","cannot_determine"].includes(a.route)&&typeof a.returnedUsdc==="string"&&typeof a.differencePct==="string"&&
    typeof a.evidence==="string"&&a.evidence.trim().length>=3&&typeof a.nextCheck==="string"&&a.nextCheck.trim().length>=3&&
    ["sampledTransaction","independentPeople","contractSafety","guaranteedExecutionOrProfit"].every(k=>typeof a.claims?.[k]==="boolean")&&
    Number.isInteger(a.confidence)&&a.confidence>=1&&a.confidence<=5&&Number.isInteger(a.effort)&&a.effort>=1&&a.effort<=5;
  };
  if(r?.studyId!=="signalproof-evidence-usability-v2"||r?.schemaVersion!==2||r?.mode!=="participant_response"||!/^[a-z0-9-]{3,24}$/i.test(code)||
   !["token_research","agent_builder","other"].includes(r.role)||!["new","some","frequent"].includes(r.experience)||
   r.assignmentCell!==design.assignmentCell||!Array.isArray(r.tasks)||r.tasks.length!==2||new Set(r.tasks.map(t=>t.caseKey)).size!==2||!r.tasks.every(validTask)){
   excluded.push({index,code,reason:"invalid_incomplete_or_wrong_study_version"});continue;
  }
  if(seen.has(code.toLowerCase())){excluded.push({index,code,reason:"duplicate_participant_code"});continue;}
  seen.add(code.toLowerCase());
  const tasks=r.tasks.map(task=>{
   const key=expected.get(task.caseKey),a=task.answer,returned=numeric(a.returnedUsdc),difference=numeric(a.differencePct),claims=a.claims;
   const routeCorrect=a.route===key.route;
   const numericCorrect=key.returnedUsdc===null?returned===null&&difference===null:
    returned!==null&&difference!==null&&Math.abs(returned-key.returnedUsdc)<=0.011&&Math.abs(difference-key.differencePct)<=0.011;
   const scopeCorrect=claims.sampledTransaction===key.sampledTransactionEstablished&&claims.independentPeople===false&&claims.contractSafety===false&&claims.guaranteedExecutionOrProfit===false;
   return {caseKey:task.caseKey,format:task.format,durationMs:task.durationMs,routeCorrect,numericCorrect,scopeCorrect,
    taskCorrect:routeCorrect&&numericCorrect&&scopeCorrect,evidenceNeedsHumanReview:a.evidence,nextCheckNeedsHumanReview:a.nextCheck,
    confidence:a.confidence,effort:a.effort,criticalMisunderstanding:claims.independentPeople||claims.contractSafety||claims.guaranteedExecutionOrProfit};
  });
  accepted.push({participantCode:code,role:r.role,experience:r.experience,assignmentCell:r.assignmentCell,tasks,feedback:r.feedback??"",usefulness:r.usefulness??""});
 }
 const median=list=>{if(!list.length)return null;const s=[...list].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
 const formats={},cells=Object.fromEntries([1,2,3,4].map(cell=>[cell,accepted.filter(r=>r.assignmentCell===cell).length]));
 for(const format of ["market_summary","integrated_brief"]){
  const tasks=accepted.flatMap(r=>r.tasks).filter(t=>t.format===format);
  formats[format]={taskCount:tasks.length,correctTasks:tasks.filter(t=>t.taskCorrect).length,criticalMisunderstandings:tasks.filter(t=>t.criticalMisunderstanding).length,
   medianDurationMs:median(tasks.map(t=>t.durationMs)),medianEffort:median(tasks.map(t=>t.effort)),
   cases:[...expected.keys()].map(caseKey=>({caseKey,count:tasks.filter(t=>t.caseKey===caseKey).length,correct:tasks.filter(t=>t.caseKey===caseKey&&t.taskCorrect).length}))};
 }
 return {status:accepted.length?"responses_pending_facilitator_review":"awaiting_participants",studyVersion:2,eligibleResponseFiles:accepted.length,
  assignmentCells:cells,allFourCellsRepresented:Object.values(cells).every(n=>n>0),excluded,formats,responses:accepted,humanUsefulnessProven:false,
  limitations:["Response files require facilitator review of genuine participation, evidence citations and next-check reasoning.",
   "Same facts are accessible in both presentations. Different cases within a session are counterbalanced across four assignments; unbalanced recruitment and small samples limit comparisons.",
   "Descriptive correctness, timings, effort and comments do not establish causal superiority, competitor performance or trading returns."]};
}
async function main(){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),folder=resolve(root,"user-study/results");
 await mkdir(folder,{recursive:true});const files=(await readdir(folder)).filter(f=>f.endsWith(".json")).sort(),records=[];
 for(const file of files){try{records.push(JSON.parse(await readFile(resolve(folder,file),"utf8")));}catch{records.push({invalidFile:file});}}
 const pack=JSON.parse(await readFile(resolve(root,"demo/casepack.json"),"utf8"));
 const report={evaluatedAt:new Date().toISOString(),...summarizeResponses(records,expectedAnswers(pack))};
 await writeFile(resolve(root,"outputs/usability-summary.json"),JSON.stringify(report,null,2));
 console.log(JSON.stringify({status:report.status,eligibleResponseFiles:report.eligibleResponseFiles,excluded:report.excluded.length,humanUsefulnessProven:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
