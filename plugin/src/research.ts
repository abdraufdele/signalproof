import * as z from "zod/v4";
import {buildBrief,evidenceBriefSchema,positionAmount,type ResearchRequest} from "./brief.js";

const USDC="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CG="https://api.coingecko.com/api/v3/onchain/networks/base/";
const RPC="https://mainnet.base.org";
const TRANSFER="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const address=/^0x[0-9a-f]{40}$/i,hash=/^0x[0-9a-f]{64}$/i;
const poolId=/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const hosts=new Set(["api.coingecko.com","api.dexscreener.com","api.0x.org","mainnet.base.org"]);
type Obj={ [key:string]:unknown };
export type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;
type Source={url:string;fetchedAt:string;httpStatus:number|null;body:unknown;error:string|null};
const obj=(v:unknown):Obj=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
const arr=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const str=(v:unknown):string=>typeof v==="string"?v:"";
const lower=(v:unknown)=>str(v).toLowerCase();
const num=(v:unknown):number|null=>(typeof v!=="number"&&typeof v!=="string")||v===""||!Number.isFinite(Number(v))?null:Number(v);
const stamp=()=>new Date().toISOString();
const block=(v:unknown)=>/^(0|[1-9][0-9]{0,19})$/.test(str(v))?str(v):null;
const iso=(v:unknown)=>str(v).length<=40&&Number.isFinite(Date.parse(str(v)))?str(v):null;
const maybeNumber=z.number().nullable();
export const verificationOutputSchema=z.object({
 transactionHash:z.string(),token:z.string(),chainId:z.literal(8453),checkedAt:z.string(),
 status:z.enum(["sample_verified","unresolved"]),chainVerified:z.boolean(),hashesMatch:z.boolean(),
 senderMatches:z.boolean(),blockHashesMatch:z.boolean(),transactionSucceeded:z.boolean(),targetTokenTransferObserved:z.boolean(),
 expectedPool:z.string().nullable(),reportedPoolLogObserved:z.boolean().nullable(),
 poolActivityState:z.enum(["address_log_observed","address_log_not_observed","pool_id_not_checked","not_requested","unresolved"]),
 swapDirectionAndAmountVerified:z.literal(false),errors:z.array(z.string()).max(4),
 observedSender:z.string().nullable(),senderCodeState:z.enum(["not_checked","unknown","no_code","delegated_code","code_present"]),
 sourceUrl:z.literal(RPC),explorerUrl:z.string(),limitations:z.array(z.string())
}).strict();

const poolSchema=z.object({
 pool:z.string(),identifierKind:z.enum(["address","pool_id"]),sourceUrl:z.string(),
 fetchedAt:z.string(),metadataFetchedAt:z.string(),httpStatus:z.number().nullable(),error:z.string().nullable(),
 liquidityUsd:maybeNumber,reportedH1VolumeUsd:maybeNumber,reportedH1PriceChangePct:maybeNumber,
 poolCreatedAt:z.string().nullable(),validSwapRecords:z.number(),rejectedRecords:z.number(),
 uniqueTransactionHashes:z.number(),uniqueSenderAddresses:z.number(),uniqueBuyerAddresses:z.number(),
 topFiveObservedBuySharePct:maybeNumber,windowStart:z.string().nullable(),windowEnd:z.string().nullable(),
 recentRecordCapReached:z.boolean(),sampleTransactionHashes:z.array(z.string()).max(2),
 sampleTransactions:z.array(z.object({transactionHash:z.string(),reportedSender:z.string()}).strict()).max(2),lastObservedTradeAgeMinutes:maybeNumber
}).strict();
const quoteSchema=z.object({
 inputUsdc:z.number(),inputUsdcAtomic:z.string(),buyHttpStatus:z.number().nullable(),buyLiquidityAvailable:z.boolean().nullable(),
 buyPriceAvailable:z.boolean(),reverseHttpStatus:z.number().nullable(),reversePriceMatched:z.boolean(),
 returnedUsdc:maybeNumber,roundTripDifferencePct:maybeNumber,buyBlock:z.string().nullable(),reverseBlock:z.string().nullable(),
 buyFetchedAt:z.string(),reverseFetchedAt:z.string().nullable(),buySourceUrl:z.string(),reverseSourceUrl:z.string().nullable(),
 buyAmountAtomic:z.string().nullable(),error:z.string().nullable()
}).strict();
const researchDataSchema=z.object({
 token:z.string(),chainId:z.literal(8453),generatedAt:z.string(),positionUsdc:z.string(),positionAtomic:z.string(),maxRoundTripDifferencePct:maybeNumber,maxTradeAgeMinutes:z.number(),
 evidenceStatus:z.enum(["execution_evidence_incomplete","exit_evidence_incomplete","indicative_entry_and_exit_available"]),
 pools:z.array(poolSchema).max(2),quotes:z.array(quoteSchema).max(4),
 crossPoolUniqueTransactionHashes:z.number(),crossPoolOverlappingTransactionHashes:z.number(),
 discovery:z.object({coinGeckoSourceUrl:z.string(),dexScreenerSourceUrl:z.string(),coinGeckoHttpStatus:z.number().nullable(),coinGeckoPoolCount:z.number(),dexScreenerHttpStatus:z.number().nullable(),dexScreenerPoolCount:z.number(),commonIdentifiers:z.number(),coinGeckoError:z.string().nullable(),dexScreenerError:z.string().nullable(),liquidityDisagreements:z.array(z.object({pool:z.string(),coinGeckoUsd:z.number(),dexScreenerUsd:z.number()}).strict()).max(2)}).strict(),
 repeated25UsdcCostChangePct:maybeNumber,referenceRecheck:z.object({sourceUrl:z.string(),fetchedAt:z.string(),blockNumber:z.string().nullable(),error:z.string().nullable()}).strict(),verification:verificationOutputSchema.nullable(),
 selectedVerificationClaims:z.number(),
 sampleChecks:z.array(z.object({pool:z.string(),check:verificationOutputSchema}).strict()).max(2),
 findings:z.array(z.string()).max(16),unknowns:z.array(z.string()).max(16),
 noPaymentOrTradeExecuted:z.literal(true)
}).strict();

export type EvidenceData=z.infer<typeof researchDataSchema>;
export const researchOutputSchema=researchDataSchema.extend({brief:evidenceBriefSchema}).strict();

function getReader(fetcher:Fetcher,totalBudgetMs:number){
 const deadline=performance.now()+totalBudgetMs;
 // Space actual 0x request starts; no retries and no cross-operation state.
 // 275ms leaves margin under the documented ~5 RPS shared standard quota.
 let quoteStartTail:Promise<void>=Promise.resolve(),lastQuoteStart=-Infinity;
 const waitForQuoteSlot=()=>{
  const turn=quoteStartTail.then(async()=>{
   const wait=Math.max(0,lastQuoteStart+275-performance.now());
   if(wait+100>=deadline-performance.now())return false;
   while(lastQuoteStart+275>performance.now())await new Promise<void>(resolve=>setTimeout(resolve,Math.max(1,lastQuoteStart+275-performance.now())));
   if(deadline-performance.now()<100)return false;
   return true;
  });
  quoteStartTail=turn.then(()=>undefined,()=>undefined);
  return turn;
 };
 return async(url:string,payload?:Obj):Promise<Source>=>{
  const parsed=new URL(url);
  if(parsed.protocol!=="https:"||!hosts.has(parsed.hostname)||parsed.username||parsed.password||parsed.port)throw new Error("Invalid destination");
  if(payload&&!(url===RPC&&["eth_chainId","eth_getTransactionReceipt","eth_getTransactionByHash","eth_getCode"].includes(str(payload.method))))throw new Error("Only read-only RPC methods are permitted");
  if(parsed.hostname==="api.0x.org"&&!await waitForQuoteSlot())
   return {url,fetchedAt:stamp(),httpStatus:null,body:null,error:"operation_budget_exhausted"};
  const remaining=deadline-performance.now();
  if(remaining<100)return {url,fetchedAt:stamp(),httpStatus:null,body:null,error:"operation_budget_exhausted"};
  const controller=new AbortController(),requestMs=Math.max(1,Math.min(2800,remaining));
  let timer:ReturnType<typeof setTimeout>|undefined;
  let status:number|null=null;
  const httpError=(code:number)=>code===429?"rate_limited":code===401||code===403?"authentication_or_access":code>=400?"provider_http_error":null;
  const operation=async():Promise<Source>=>{
   if(parsed.hostname==="api.0x.org")lastQuoteStart=performance.now();
   const response=await fetcher(url,{method:payload?"POST":"GET",redirect:"error",
    headers:payload?{"content-type":"application/json"}:parsed.hostname==="api.0x.org"?{"0x-version":"v2"}:{},
    ...(payload?{body:JSON.stringify(payload)}:{}),signal:controller.signal});
   status=response.status;
   const chunks:Uint8Array[]=[];let count=0;
   if(response.body){
    const stream=response.body.getReader();
    try{for(;;){
     const item=await stream.read();if(item.done)break;
     count+=item.value.byteLength;
     if(count>700*1024){await stream.cancel();throw new Error("response_too_large");}
     chunks.push(item.value);
    }}finally{stream.releaseLock();}
   }
   const bytes=new Uint8Array(count);let offset=0;
   for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   let body:unknown;
   try{body=JSON.parse(new TextDecoder().decode(bytes));}
   catch{return {url,fetchedAt:stamp(),httpStatus:response.status,body:null,error:httpError(response.status)??"non_json_response"};}
   return {url,fetchedAt:stamp(),httpStatus:response.status,body,error:httpError(response.status)};
  };
  try{
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("network_or_timeout"));},requestMs);});
   return await Promise.race([operation(),timeout]);
  }catch(error){
   const code=error instanceof Error&&error.message==="response_too_large"?"response_too_large":"network_or_timeout";
   return {url,fetchedAt:stamp(),httpStatus:status,body:null,error:code};
  }finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
function usablePrice(source:Source|null,expectedSell?:string){
 const b=obj(source?.body);
 const requested=source?new URL(source.url).searchParams:null;
 return address.test(str(b.sellToken))&&address.test(str(b.buyToken))
  &&lower(b.sellToken)===lower(requested?.get("sellToken"))&&lower(b.buyToken)===lower(requested?.get("buyToken"))
  &&source?.httpStatus===200&&b.liquidityAvailable===true
  &&/^[1-9][0-9]{0,77}$/.test(str(b.buyAmount))&&/^[1-9][0-9]{0,77}$/.test(str(b.sellAmount))
  &&BigInt(str(b.buyAmount))<2n**256n&&BigInt(str(b.sellAmount))<2n**256n
  &&(expectedSell===undefined||b.sellAmount===expectedSell);
}
function priceUrl(sellToken:string,buyToken:string,sellAmount:string){
 return "https://api.0x.org/swap/allowance-holder/price?"+new URLSearchParams({chainId:"8453",sellToken,buyToken,sellAmount});
}
function poolSummary(pool:unknown,source:Source,metadataFetchedAt:string){
 const a=obj(obj(pool).attributes),seen=new Set<string>(),transactions=new Set<string>(),senders=new Set<string>(),buyers=new Map<string,number>();
 let rejected=0,valid=0,buys=0;const dates:string[]=[];
 const samples:{transactionHash:string;reportedSender:string}[]=[];
 const raw=arr(obj(source.body).data);
 const ordered=[...raw].sort((a,b)=>{
  const x=obj(obj(a).attributes),y=obj(obj(b).attributes);
  const tx=Date.parse(str(x.block_timestamp)),ty=Date.parse(str(y.block_timestamp));
  return (Number.isFinite(ty)?ty:0)-(Number.isFinite(tx)?tx:0)||lower(x.tx_hash).localeCompare(lower(y.tx_hash))||str(obj(a).id).localeCompare(str(obj(b).id));
 });
 for(const entry of ordered){
  const r=obj(entry),t=obj(r.attributes),volume=num(t.volume_in_usd),timestamp=str(t.block_timestamp),id=str(r.id);
  if(!id||!address.test(str(t.tx_from_address))||!hash.test(str(t.tx_hash))||!["buy","sell"].includes(str(t.kind))||volume===null||volume<0||!iso(timestamp)){rejected++;continue;}
  if(seen.has(id))continue;seen.add(id);valid++;
  if(!transactions.has(lower(t.tx_hash))&&samples.length<2)samples.push({transactionHash:lower(t.tx_hash),reportedSender:lower(t.tx_from_address)});
  transactions.add(lower(t.tx_hash));senders.add(lower(t.tx_from_address));dates.push(timestamp);
  if(t.kind==="buy"){buys+=volume;buyers.set(lower(t.tx_from_address),(buyers.get(lower(t.tx_from_address))??0)+volume);}
 }
 dates.sort((a,b)=>Date.parse(a)-Date.parse(b));
 const top=[...buyers.values()].sort((a,b)=>b-a).slice(0,5).reduce((sum,v)=>sum+v,0);
 return {summary:{pool:str(a.address),identifierKind:str(a.address).length===66?"pool_id" as const:"address" as const,
  sourceUrl:source.url,fetchedAt:source.fetchedAt,metadataFetchedAt,httpStatus:source.httpStatus,error:source.error,
  liquidityUsd:num(a.reserve_in_usd),reportedH1VolumeUsd:num(obj(a.volume_usd).h1),
  reportedH1PriceChangePct:num(obj(a.price_change_percentage).h1),poolCreatedAt:iso(a.pool_created_at),
  validSwapRecords:valid,rejectedRecords:rejected,uniqueTransactionHashes:transactions.size,
  uniqueSenderAddresses:senders.size,uniqueBuyerAddresses:buyers.size,
  topFiveObservedBuySharePct:buys>0?top/buys*100:null,windowStart:dates[0]??null,windowEnd:dates.at(-1)??null,
  recentRecordCapReached:raw.length>=300,sampleTransactionHashes:[...transactions].slice(0,2),sampleTransactions:samples,
  lastObservedTradeAgeMinutes:dates.at(-1)?(Date.now()-Date.parse(dates.at(-1)!))/60000:null},transactions};
}
export async function inspectToken(token:string,fetcher:Fetcher=fetch,budgetMs=8500,request:ResearchRequest={}){
 if(!address.test(token))throw new Error("Invalid token contract");
 token=token.toLowerCase();
 if(token===USDC)throw new Error("USDC is the reference asset; choose a different Base token contract.");
 const position=positionAmount(request.positionUsdc??"500");
 const limit=request.maxRoundTripDifferencePct??null;
 if(limit!==null&&(!Number.isFinite(limit)||limit<0||limit>100))throw new Error("Cost limit must be 0–100 percent.");
 const maxTradeAgeMinutes=request.maxTradeAgeMinutes??30;
 if(!Number.isFinite(maxTradeAgeMinutes)||maxTradeAgeMinutes<1||maxTradeAgeMinutes>1440)throw new Error("Maximum trade age must be 1–1440 minutes.");
 const deadline=performance.now()+budgetMs;
 const get=getReader(fetcher,budgetMs),sizes=[positionAmount("25"),positionAmount("100"),positionAmount("500")];
 if(!sizes.some(size=>size.atomic===position.atomic))sizes.push(position);
 // All keys are host-scoped brokered headers supplied by PayBox, never env values.
 const [poolsSource,dexSource,...buys]=await Promise.all([
  get(CG+"tokens/"+token+"/pools?include=base_token,quote_token,dex"),
  get("https://api.dexscreener.com/token-pairs/v1/base/"+token),
  ...sizes.map(size=>get(priceUrl(USDC,token,size.atomic)))
 ]);
 const cgPools=arr(obj(poolsSource.body).data).filter(p=>{
  const a=obj(obj(p).attributes),relationships=obj(obj(p).relationships);
  const base=str(obj(obj(relationships.base_token).data).id),quote=str(obj(obj(relationships.quote_token).data).id);
  return poolId.test(str(a.address))&&[base.toLowerCase(),quote.toLowerCase()].includes("base_"+token);
 });
 const selected=[...new Map(cgPools.map(p=>[lower(obj(obj(p).attributes).address),p])).values()].slice(0,2);
 const phaseTwo=await Promise.all([
  ...selected.map(p=>get(CG+"pools/"+str(obj(obj(p).attributes).address)+"/trades?token="+token)),
  ...buys.map((buy,i)=>usablePrice(buy,sizes[i]!.atomic)?get(priceUrl(token,USDC,str(obj(buy.body).buyAmount))):Promise.resolve(null)),
  get(priceUrl(USDC,token,"25000000"))
 ]);
 const tradeSources=phaseTwo.slice(0,selected.length) as Source[];
 const reverses=phaseTwo.slice(selected.length,selected.length+sizes.length) as (Source|null)[];
 const repeated=phaseTwo.at(-1) as Source;
 const summaries=selected.map((p,i)=>poolSummary(p,tradeSources[i]!,poolsSource.fetchedAt));
 const pools=summaries.map(p=>p.summary);
 const allTransactions=new Set(summaries.flatMap(p=>[...p.transactions]));
 const overlapping=summaries.reduce((sum,p)=>sum+p.transactions.size,0)-allTransactions.size;
 const quotes=sizes.map((size,i)=>{
  const inputUsdc=size.display;
  const buy=buys[i]!,back=reverses[i]??null,body=obj(buy.body);
  const buyValid=usablePrice(buy,size.atomic);
  const reverseMatched=buyValid&&usablePrice(back,str(body.buyAmount));
  const returned=reverseMatched?Number(BigInt(str(obj(back?.body).buyAmount)))/1e6:null;
  return {inputUsdc,inputUsdcAtomic:size.atomic,buyHttpStatus:buy.httpStatus,buyLiquidityAvailable:typeof body.liquidityAvailable==="boolean"?body.liquidityAvailable:null,
   buyPriceAvailable:buyValid,reverseHttpStatus:back?.httpStatus??null,reversePriceMatched:reverseMatched,returnedUsdc:returned,
   roundTripDifferencePct:returned===null?null:(inputUsdc-returned)/inputUsdc*100,
   buyBlock:block(body.blockNumber),reverseBlock:block(obj(back?.body).blockNumber),
   buyFetchedAt:buy.fetchedAt,reverseFetchedAt:back?.fetchedAt??null,buySourceUrl:buy.url,reverseSourceUrl:back?.url??null,
   buyAmountAtomic:buyValid?str(body.buyAmount):null,error:buy.error??(body.liquidityAvailable===true&&!buyValid?"invalid_price_fields":null)??back?.error??(obj(back?.body).liquidityAvailable===true&&!reverseMatched?"invalid_reverse_fields":null)};
 });
 let repeatedChange:number|null=null;
 if(usablePrice(buys[0]??null,"25000000")&&usablePrice(repeated,"25000000")){
  const first=BigInt(str(obj(buys[0]?.body).buyAmount)),last=BigInt(str(obj(repeated.body).buyAmount));
  repeatedChange=Number((first-last)*1000000n/last)/10000;
 }
 // One newest observed claim per selected pool; timestamp then hash determine selection.
 const claims=pools.flatMap(pool=>pool.sampleTransactions[0]?[{pool:pool.pool,...pool.sampleTransactions[0]}]:[]);
 const remaining=deadline-performance.now()-150;
 const memo=new Map<string,Promise<Source>>();
 const bounded=getReader(fetcher,Math.max(1,Math.min(2500,remaining)));
 const shared:ReturnType<typeof getReader>=(url,payload)=>{
  const key=url+JSON.stringify(payload??null);
  if(!memo.has(key))memo.set(key,bounded(url,payload));
  return memo.get(key)!;
 };
 const sampleChecks=remaining>200?await Promise.all(claims.map(async claim=>({
  pool:claim.pool,check:await verifyWithReader(token,claim.transactionHash,claim.reportedSender,shared,claim.pool)
 }))):[];
 const verification=sampleChecks[0]?.check??null;
 const findings:string[]=[],unknowns=[
  "Recent sampled trades only; sender addresses are not independent people, holders, bots or smart money.",
  "Pool creation is not token launch time. Token safety and common ownership are not established.",
  "Sequential indicative buy/reverse prices combine routing, provider fees and market movement; gas is excluded.",
  "Taker omitted: no wallet balance or allowance check. No execution, future exit or profit guarantee.",
  "At most one deterministically selected transaction per pool is checked within a shared budget. Token activity and pool-log evidence are separate; direction and amount are not verified.",
  "Provider lists may differ in indexing and pool representation; matching lists do not independently validate reserves."
 ];
 for(const p of pools){
  if(p.reportedH1VolumeUsd!==null&&p.reportedH1VolumeUsd>0&&p.liquidityUsd===0)findings.push("Pool "+p.pool+" reports historical volume alongside zero current liquidity.");
  if(p.validSwapRecords===0)unknowns.push("No usable observed trades for pool "+p.pool+".");
  if(p.recentRecordCapReached)unknowns.push("Recent trade sample is capped at 300 for pool "+p.pool+".");
 }
 for(const q of quotes){
  if(!q.buyPriceAvailable)findings.push(q.inputUsdc+" USDC: buy pricing unresolved"+(q.buyLiquidityAvailable===false?" (provider reports no available liquidity).":"."));
  else if(!q.reversePriceMatched)findings.push(q.inputUsdc+" USDC: matched reverse pricing unresolved; not proof of a honeypot.");
  else findings.push(q.inputUsdc+" USDC: indicative reverse returns "+q.returnedUsdc!.toFixed(6)+" USDC before gas.");
 }
 if(repeatedChange!==null&&Math.abs(repeatedChange)>1)unknowns.push("Repeated 25-USDC rate moved by more than 1%; size comparisons are unstable.");
 const dexPairs=arr(dexSource.body).filter(p=>{
  const d=obj(p);
  return d.chainId==="base"&&poolId.test(str(d.pairAddress))&&[lower(obj(d.baseToken).address),lower(obj(d.quoteToken).address)].includes(token);
 });
 const liquidityDisagreements=pools.flatMap(pool=>{
  const dex=dexPairs.find(p=>lower(obj(p).pairAddress)===pool.pool.toLowerCase());
  const other=num(obj(obj(dex).liquidity).usd);
  return pool.liquidityUsd!==null&&other!==null&&((pool.liquidityUsd===0&&other>0)||(other===0&&pool.liquidityUsd>0))?
   [{pool:pool.pool,coinGeckoUsd:pool.liquidityUsd,dexScreenerUsd:other}]:[];
 });
 const dexIds=new Set(dexPairs.map(p=>lower(obj(p).pairAddress)));
 const status=pools.length===0||pools.some(p=>p.httpStatus!==200)||quotes.some(q=>!q.buyPriceAvailable)?"execution_evidence_incomplete":
  quotes.some(q=>!q.reversePriceMatched)?"exit_evidence_incomplete":"indicative_entry_and_exit_available";
 const data=researchDataSchema.parse({token,chainId:8453,generatedAt:stamp(),positionUsdc:position.usdc,positionAtomic:position.atomic,maxRoundTripDifferencePct:limit,maxTradeAgeMinutes,evidenceStatus:status,
  pools,quotes,crossPoolUniqueTransactionHashes:allTransactions.size,crossPoolOverlappingTransactionHashes:overlapping,
  discovery:{coinGeckoSourceUrl:poolsSource.url,dexScreenerSourceUrl:dexSource.url,coinGeckoHttpStatus:poolsSource.httpStatus,coinGeckoPoolCount:cgPools.length,
   dexScreenerHttpStatus:dexSource.httpStatus,dexScreenerPoolCount:dexPairs.length,
   commonIdentifiers:cgPools.filter(p=>dexIds.has(lower(obj(obj(p).attributes).address))).length,coinGeckoError:poolsSource.error,dexScreenerError:dexSource.error,liquidityDisagreements},
  repeated25UsdcCostChangePct:repeatedChange,referenceRecheck:{sourceUrl:repeated.url,fetchedAt:repeated.fetchedAt,blockNumber:block(obj(repeated.body).blockNumber),error:repeated.error},verification,selectedVerificationClaims:claims.length,sampleChecks,findings,unknowns:unknowns.slice(0,16),noPaymentOrTradeExecuted:true});
 return researchOutputSchema.parse({...data,brief:buildBrief(data)});
}

export async function verifySample(token:string,transactionHash:string,expectedSender?:string,fetcher:Fetcher=fetch,budgetMs=7000,expectedPool?:string){
 if(!address.test(token)||!hash.test(transactionHash)||(expectedSender&&!address.test(expectedSender))||(expectedPool&&!poolId.test(expectedPool)))throw new Error("Invalid onchain identifier");
 return verifyWithReader(token,transactionHash,expectedSender,getReader(fetcher,budgetMs),expectedPool);
}
async function verifyWithReader(token:string,transactionHash:string,expectedSender:string|undefined,get:ReturnType<typeof getReader>,expectedPool?:string){
 const call=(method:string,params:unknown[])=>get(RPC,{jsonrpc:"2.0",id:1,method,params});
 const [chainSource,receiptSource,txSource,codeSource]=await Promise.all([
  call("eth_chainId",[]),call("eth_getTransactionReceipt",[transactionHash]),call("eth_getTransactionByHash",[transactionHash]),
  expectedSender?call("eth_getCode",[expectedSender,"latest"]):Promise.resolve(null)
 ]);
 const sources=[chainSource,receiptSource,txSource,codeSource].filter((s):s is Source=>s!==null);
 const errors=sources.flatMap(s=>s.error?[s.error]:obj(s.body).error?["rpc_error"]:s.httpStatus!==200?["provider_http_error"]:[]);
 const result=(source:Source)=>source.httpStatus===200&&!source.error&&!obj(source.body).error?obj(source.body).result:null;
 const r=obj(result(receiptSource)),t=obj(result(txSource));
 const chainVerified=result(chainSource)==="0x2105";
 const hashesMatch=lower(r.transactionHash)===transactionHash.toLowerCase()&&lower(t.hash)===transactionHash.toLowerCase();
 const senderMatches=address.test(str(r.from))&&lower(r.from)===lower(t.from)&&(!expectedSender||lower(r.from)===expectedSender.toLowerCase());
 const blockHashesMatch=hash.test(str(r.blockHash))&&lower(r.blockHash)===lower(t.blockHash);
 const transactionSucceeded=r.status==="0x1";
 const logs=arr(r.logs).map(obj);
 // A canonical Transfer has indexed from/to addresses and one uint256 data word.
 const transfer=logs.some(l=>lower(l.address)===token.toLowerCase()&&arr(l.topics).length===3&&
  lower(arr(l.topics)[0])===TRANSFER&&arr(l.topics).slice(1).every(t=>hash.test(str(t)))&&/^0x[0-9a-f]{64}$/i.test(str(l.data))&&l.removed!==true);
 const poolLog=expectedPool&&address.test(expectedPool)&&chainVerified&&hashesMatch&&blockHashesMatch&&transactionSucceeded?
  logs.some(l=>lower(l.address)===expectedPool.toLowerCase()&&l.removed!==true&&arr(l.topics).some(t=>hash.test(str(t)))):null;
 const poolActivityState=!expectedPool?"not_requested":expectedPool.length===66?"pool_id_not_checked":
  poolLog===null?"unresolved":poolLog?"address_log_observed":"address_log_not_observed";
 const code=codeSource?result(codeSource):null;
 const codeState=!expectedSender?"not_checked":typeof code!=="string"||!/^0x(?:[0-9a-f]{2})*$/i.test(code)?"unknown":code==="0x"?"no_code":code.startsWith("0xef0100")?"delegated_code":"code_present";
 return verificationOutputSchema.parse({transactionHash,token,chainId:8453,checkedAt:stamp(),
  status:chainVerified&&hashesMatch&&senderMatches&&blockHashesMatch&&transactionSucceeded&&transfer?"sample_verified":"unresolved",
  chainVerified,hashesMatch,senderMatches,blockHashesMatch,transactionSucceeded,targetTokenTransferObserved:transfer,
  expectedPool:expectedPool??null,reportedPoolLogObserved:poolLog,poolActivityState,swapDirectionAndAmountVerified:false,errors:[...new Set(errors)].slice(0,4),
  observedSender:address.test(str(r.from))?str(r.from):null,senderCodeState:codeState,sourceUrl:RPC,explorerUrl:"https://basescan.org/tx/"+transactionHash,
  limitations:["Sample success verifies transaction/sender/token activity only. A log at the reported pool address establishes address activity, not the swap direction, amount, economic owner or all pool records.",
   "A 32-byte pool ID is not an emitting address; its association is not verified by this log-address check.",
   "Bytecode is checked at latest state when a sender is supplied; it is not a human/bot classifier. RPC is a separate source, not a trustless proof."]});
}
