import {holderCandidates} from "./holder-candidates.js";
import * as z from "zod/v4";
const RPC="https://mainnet.base.org",PROVIDER="https://pro-api.coinmarketcap.com/public-api/v1/dex/holders/list";
const address=/^0x[0-9a-f]{40}$/i,hash=/^0x[0-9a-f]{64}$/i;
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const hex=(v:unknown)=>typeof v==="string"&&/^0x[0-9a-f]{1,64}$/i.test(v)?BigInt(v):null;
const pct=(n:bigint,d:bigint)=>d>0n?Number(n*1000000n/d)/10000:null;
const display=(n:bigint,decimals:number)=>{const s=n.toString().padStart(decimals+1,"0");return decimals?s.slice(0,-decimals)+"."+s.slice(-decimals):s;};
export const holderOutputSchema=z.object({token:z.string(),chainId:z.literal(8453),checkedAt:z.string(),status:z.enum(["synchronized","partial","unavailable"]),
 blockNumber:z.string().nullable(),blockHash:z.string().nullable(),blockTime:z.string().nullable(),blockHashRechecked:z.boolean(),
 sourceUrl:z.literal(PROVIDER),rpcUrl:z.literal(RPC),providerObservedAt:z.string().nullable(),candidateSource:z.enum(["live_provider","bundled_candidate_snapshot","unavailable"]),candidateSnapshotAgeMinutes:z.number().nullable(),providerWarnings:z.array(z.string()).max(8),providerCandidateCount:z.number(),candidateLimit:z.literal(80),candidateCount:z.number(),verifiedBalanceCount:z.number(),decimals:z.number().nullable(),totalSupplyAtomic:z.string().nullable(),coveredSupplyPct:z.number().nullable(),
 topFiveCandidateSharePct:z.number().nullable(),topTenCandidateSharePct:z.number().nullable(),rankScope:z.literal("provider_candidates_rebalanced_at_one_block"),completeHolderUniverseVerified:z.literal(false),beneficialOwnershipVerified:z.literal(false),
 holders:z.array(z.object({address:z.string(),balanceAtomic:z.string(),balance:z.string(),shareOfTotalSupplyPct:z.number().nullable(),providerLabel:z.string().nullable(),codeState:z.enum(["contract_code","no_code","unavailable"])}).strict()).max(100),
 gaps:z.array(z.string()).max(12),limitations:z.array(z.string()),noPaymentOrTradeExecuted:z.literal(true)}).strict();
export async function inspectHolders(token:string,fetcher:typeof fetch=fetch,budgetMs=8500){
 if(!address.test(token))throw Error("Invalid Base token contract");token=token.toLowerCase();const deadline=performance.now()+budgetMs,gaps:string[]=[];
 async function request(url:string,body:unknown){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const remaining=deadline-performance.now();if(remaining<100)return null;
  try{
   const operation=(async()=>{const r=await fetcher(url,{method:"POST",redirect:"error",signal:controller.signal,headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(!r.ok){gaps.push(url===PROVIDER?"Holder candidate provider HTTP "+r.status:"RPC HTTP "+r.status);return null;}
    const chunks:Uint8Array[]=[];let size=0;const reader=r.body?.getReader();if(!reader)return null;
    try{for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>700*1024){await reader.cancel();throw Error("response_too_large");}chunks.push(c.value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes)) as unknown;})();
   return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("timeout"));},Math.min(url===PROVIDER?1500:3000,remaining));})]);
  }catch{gaps.push(url===PROVIDER?"Candidate provider unavailable or invalid":"RPC unavailable or invalid");return null;}finally{if(timer)clearTimeout(timer);controller.abort();}
 }
 const call=(id:number,method:string,params:unknown[])=>({jsonrpc:"2.0",id,method,params});
 const [provider,bootstrap]=await Promise.all([request(PROVIDER,{tokenAddress:token,platform:"base",tag:"tag_all"}),request(RPC,[call(1,"eth_chainId",[]),call(2,"eth_getBlockByNumber",["latest",false])])]);
 const boot=Array.isArray(bootstrap)?bootstrap:[];const result=(rows:unknown[],id:number)=>{const r=obj(rows.find(v=>obj(v).id===id));return r.error?null:r.result;};
 const block=obj(result(boot,2)),blockHex=typeof block.number==="string"&&hex(block.number)!==null?block.number:null;
 const blockHash=typeof block.hash==="string"&&hash.test(block.hash)?block.hash:null;
 const timestamp=hex(block.timestamp),blockTime=timestamp!==null&&timestamp<100000000000n?new Date(Number(timestamp)*1000).toISOString():null;
 const chain=result(boot,1)==="0x2105";
 if(!chain)gaps.push("Base chain not verified");if(!blockHex||!blockHash||!blockTime)gaps.push("Fixed block identity unavailable");
 if(blockTime&&(Date.now()-Date.parse(blockTime)>300000||Date.parse(blockTime)-Date.now()>60000))gaps.push("RPC block timestamp stale or future");
 let raw=obj(obj(provider).data).holders??obj(provider).holders;
 const providerWarnings:string[]=[];let candidateSource:"live_provider"|"bundled_candidate_snapshot"|"unavailable"=Array.isArray(raw)&&raw.length?"live_provider":"unavailable";
 let candidateObservedAt=typeof obj(obj(provider).status).timestamp==="string"&&Number.isFinite(Date.parse(obj(obj(provider).status).timestamp as string))?obj(obj(provider).status).timestamp as string:null;
 const snapshotAge=(Date.now()-Date.parse(holderCandidates.observedAt))/60000;
 if(candidateSource==="unavailable"&&token===holderCandidates.token&&snapshotAge>=0&&snapshotAge<=1440){raw=[...holderCandidates.holders];candidateSource="bundled_candidate_snapshot";candidateObservedAt=holderCandidates.observedAt;providerWarnings.push(...gaps.filter(g=>g.startsWith("Holder candidate")||g.startsWith("Candidate provider")));for(let i=gaps.length-1;i>=0;i--)if(gaps[i]!.startsWith("Holder candidate")||gaps[i]!.startsWith("Candidate provider"))gaps.splice(i,1);providerWarnings.push("Using dated public candidate snapshot; balances and supply are still read live at the reported fixed block.");}
 const candidates:{address:string;label:string|null}[]=[],seen=new Set<string>();let rejected=0;
 if(Array.isArray(raw))for(const item of raw.slice(0,80)){
  const v=obj(item),a=String(v.walletAddress??"").toLowerCase();
  if(!address.test(a)||a==="0x"+"0".repeat(40)||seen.has(a)||String(v.tokenAddress??"").toLowerCase()!==token){rejected++;continue;}
  seen.add(a);candidates.push({address:a,label:typeof v.publicName==="string"&&v.publicName?v.publicName.slice(0,100):null});
 }
 if(!candidates.length)gaps.push("No usable holder candidates");if(rejected)gaps.push("Rejected invalid or duplicate candidates: "+rejected);
 const jobs:ReturnType<typeof call>[]=[];
 if(chain&&blockHex&&blockHash){
  jobs.push(call(10,"eth_call",[{to:token,data:"0x18160ddd"},blockHex]),call(11,"eth_call",[{to:token,data:"0x313ce567"},blockHex]));
  candidates.forEach((v,i)=>jobs.push(call(100+i,"eth_call",[{to:token,data:"0x70a08231"+v.address.slice(2).padStart(64,"0")},blockHex])));
  candidates.slice(0,5).forEach((v,i)=>jobs.push(call(1000+i,"eth_getCode",[v.address,blockHex])));
 }
 const batches=[];for(let i=0;i<jobs.length;i+=10)batches.push(jobs.slice(i,i+10));
 const responses:unknown[]=[];let lastBatchStart=-Infinity;
 for(const batch of batches){while(performance.now()<lastBatchStart+550&&performance.now()<deadline-100)await new Promise<void>(resolve=>setTimeout(resolve,Math.max(1,lastBatchStart+550-performance.now())));lastBatchStart=performance.now();responses.push(await request(RPC,batch));}
 const rows=responses.flatMap(r=>Array.isArray(r)?r:[]);
 const supply=hex(result(rows,10)),d=hex(result(rows,11)),decimals=d!==null&&d<=36n?Number(d):null;
 if(supply===null||supply===0n||decimals===null)gaps.push("Supply or decimals unavailable at fixed block");
 const balances=candidates.flatMap((c,i)=>{const amount=hex(result(rows,100+i));return amount===null?[]:[{...c,amount,index:i}];}).sort((a,b)=>a.amount===b.amount?a.address.localeCompare(b.address):a.amount>b.amount?-1:1);
 if(balances.length!==candidates.length)gaps.push("Some candidate balances could not be verified");
 const sum=balances.reduce((n,v)=>n+v.amount,0n);if(supply!==null&&sum>supply)gaps.push("Candidate balances exceed reported totalSupply; denominator mismatch");
 const recheck=blockHex?await request(RPC,call(3,"eth_getBlockByNumber",[blockHex,false])):null;
 const rechecked=!!blockHash&&obj(obj(recheck).result).hash===blockHash;if(!rechecked)gaps.push("Fixed block hash not confirmed after balance reads");
 const validDenominator=supply!==null&&supply>0n&&sum<=supply;
 const synchronized=gaps.length===0&&balances.length>0;
 return holderOutputSchema.parse({token,chainId:8453,checkedAt:new Date().toISOString(),status:synchronized?"synchronized":balances.length?"partial":"unavailable",blockNumber:blockHex?BigInt(blockHex).toString():null,blockHash,blockTime,blockHashRechecked:rechecked,sourceUrl:PROVIDER,rpcUrl:RPC,providerObservedAt:candidateObservedAt,candidateSource,candidateSnapshotAgeMinutes:candidateObservedAt?Math.max(0,(Date.now()-Date.parse(candidateObservedAt))/60000):null,providerWarnings:providerWarnings.slice(0,8),providerCandidateCount:candidateSource==="bundled_candidate_snapshot"?holderCandidates.providerCandidateCount:Array.isArray(raw)?raw.length:0,candidateLimit:80,candidateCount:candidates.length,verifiedBalanceCount:balances.length,decimals,totalSupplyAtomic:supply?.toString()??null,coveredSupplyPct:validDenominator?pct(sum,supply!):null,topFiveCandidateSharePct:synchronized&&validDenominator?pct(balances.slice(0,5).reduce((n,v)=>n+v.amount,0n),supply!):null,topTenCandidateSharePct:synchronized&&validDenominator?pct(balances.slice(0,10).reduce((n,v)=>n+v.amount,0n),supply!):null,rankScope:"provider_candidates_rebalanced_at_one_block",completeHolderUniverseVerified:false,beneficialOwnershipVerified:false,
 holders:decimals!==null?balances.map(v=>{const code=result(rows,1000+v.index);return {address:v.address,balanceAtomic:v.amount.toString(),balance:display(v.amount,decimals),shareOfTotalSupplyPct:validDenominator?pct(v.amount,supply!):null,providerLabel:v.label,codeState:typeof code==="string"&&/^0x(?:[0-9a-f]{2})*$/i.test(code)?code==="0x"?"no_code" as const:"contract_code" as const:"unavailable" as const};}):[],gaps:[...new Set(gaps)].slice(0,12),limitations:["Up to 80 provider-reported candidates are independently rebalanced at one block. The complete holder universe and global top ranking are not independently verified.","Provider labels are attribution claims, not verified ownership. Contract balances can aggregate many users; do not equate address concentration with beneficial ownership.","For WETH only, an explicitly dated public candidate snapshot (maximum 24 hours old) can preserve discovery during provider outages; no balances or percentages are cached. Provider balances and percentages are not used in concentration calculations. The denominator is onchain totalSupply at the fixed block; WETH supply can include native-ETH accounting effects.","Code is checked only for the first five provider candidates at the same block. No-code does not prove an address is an independent person."],noPaymentOrTradeExecuted:true});
}