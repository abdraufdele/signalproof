import {readFile,readdir} from "node:fs/promises";
const fixtureRoot=new URL("../fixtures/research/",import.meta.url);
export const readSnapshot=async path=>JSON.parse(await readFile(new URL(path,fixtureRoot),"utf8"));
export const cases=(await readSnapshot("selection.json")).cases;
export async function fixtureFor(caseData,options={}){
 const root=options.root??fixtureRoot;
 const read=async path=>JSON.parse(await readFile(new URL(path,root),"utf8"));
 const prefix=caseData.token.toLowerCase()+"/";
 const [pools,dex,quotes,bracket,samples,chain,names]=await Promise.all([
  read(prefix+"pools.json"),read(prefix+"dex-pools.json"),read(prefix+"quotes.json"),read(prefix+"bracket.json"),
  read(prefix+"receipt-samples.json"),read("rpc-chain.json"),readdir(new URL(prefix,root))]);
 const codes=names.includes("sender-code.json")?await read(prefix+"sender-code.json"):[];
 const trades=await Promise.all(names.filter(n=>/^trades-\d+\.json$/.test(n)).map(n=>read(prefix+n)));
 const calls=[];let referenceCount=0;
 const fetcher=async(url,init={})=>{
  calls.push({url,init});
  if(options.onRequest){const override=await options.onRequest(url,init);if(override!==undefined)return override;}
  const u=new URL(url);let source;
  if(u.hostname==="api.dexscreener.com")source=dex;
  else if(u.hostname==="api.coingecko.com"){
   source=u.pathname.includes("/tokens/")?pools:trades.find(t=>u.pathname.includes(t.pool.attributes.address));
  }else if(u.hostname==="api.0x.org"){
   const sell=u.searchParams.get("sellToken")?.toLowerCase(),amount=u.searchParams.get("sellAmount");
   if(sell==="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"){
    source=amount==="25000000"&&referenceCount++>0?bracket:quotes.find(q=>String(q.inputUsdc*1000000)===amount)?.buy;
   }else source=quotes.find(q=>q.buy.body?.buyAmount===amount)?.sellBack;
  }else if(u.hostname==="mainnet.base.org"){
   const request=JSON.parse(init.body),sample=samples.find(s=>s.providerRecord.tx_hash.toLowerCase()===request.params?.[0]?.toLowerCase());
   if(request.method==="eth_chainId")source=chain;
   else if(request.method==="eth_getTransactionReceipt")source=sample?.receipt;
   else if(request.method==="eth_getTransactionByHash")source=sample?.transaction;
   else if(request.method==="eth_getCode")source=codes.find(c=>c.address.toLowerCase()===request.params[0].toLowerCase())?.response;
   if(!source)return new Response(JSON.stringify({jsonrpc:"2.0",id:1,error:{code:-32001,message:"Not captured in this recorded snapshot"}}));
  }
  if(!source||source.httpStatus===null)throw new Error("Recorded source unavailable");
  return new Response(JSON.stringify(source.body),{status:source.httpStatus});
 };
 return {fetcher,calls,caseData,pools,dex,quotes,bracket,trades,samples,codes,chain};
}
