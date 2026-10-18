export function assignmentFor(code,records){
 let seed=0;for(const c of code)seed=(seed*31+c.charCodeAt(0))>>>0;
 const cell=seed%4,order=cell%2?[...records].reverse():[...records];
 return {assignmentCell:cell+1,assignmentSeed:seed,queue:order.map((record,index)=>({
  record,format:(index+Math.floor(cell/2))%2?"integrated_brief":"market_summary",formatLabel:"Format "+(index+1)
 }))};
}
