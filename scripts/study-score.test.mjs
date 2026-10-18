import test from "node:test";import assert from "node:assert/strict";
import {summarizeResponses} from "./score-study.mjs";
import {assignmentFor} from "./study-design.mjs";
const expected=new Map([["a",{token:"0xaaa",capturedAt:"2026-10-16T19:00:00Z",route:"entry_and_reverse",returnedUsdc:488.815675,differencePct:2.236865,sampledTransactionEstablished:true}],
 ["b",{token:"0xbbb",capturedAt:"2026-10-16T19:00:00Z",route:"entry_only",returnedUsdc:null,differencePct:null,sampledTransactionEstablished:true}]]);
function response(code="P001"){
 const design=assignmentFor(code,[...expected.keys()].map(key=>({key})));
 return {schemaVersion:2,studyId:"signalproof-evidence-usability-v2",mode:"participant_response",participantCode:code,role:"token_research",experience:"some",
 technicalOnly:false,assignmentCell:design.assignmentCell,tasks:design.queue.map(({record,format})=>{
 const e=expected.get(record.key);return {caseKey:record.key,token:e.token,capturedAt:e.capturedAt,format,durationMs:45000,
 answer:{route:e.route,returnedUsdc:e.returnedUsdc===null?"":"488.82",differencePct:e.differencePct===null?"":"2.237",evidence:"Source row",nextCheck:"Review current routes",confidence:4,effort:2,
 claims:{sampledTransaction:true,independentPeople:false,contractSafety:false,guaranteedExecutionOrProfit:false}}};
 })};
}
test("empty study has no manufactured participant results",()=>{const r=summarizeResponses([],expected);assert.equal(r.status,"awaiting_participants");assert.equal(r.eligibleResponseFiles,0);assert.equal(r.humanUsefulnessProven,false);assert.equal(r.allFourCellsRepresented,false);});
test("technical sessions and duplicate codes do not inflate participant counts",()=>{const r=summarizeResponses([response("SMOKE-001"),response(),response()],expected);assert.equal(r.eligibleResponseFiles,1);assert.equal(r.excluded.length,2);assert.equal(r.formats.market_summary.correctTasks,1);assert.equal(r.humanUsefulnessProven,false);});
test("unsupported ownership or safety conclusions are critical misunderstandings",()=>{const s=response();s.tasks.find(t=>t.format==="integrated_brief").answer.claims.contractSafety=true;const r=summarizeResponses([s],expected);assert.equal(r.formats.integrated_brief.correctTasks,0);assert.equal(r.formats.integrated_brief.criticalMisunderstandings,1);});
test("missing tasks are rejected and unresolved numeric evidence is not invented",()=>{const s=response();s.tasks.pop();assert.equal(summarizeResponses([s],expected).eligibleResponseFiles,0);const r=response();r.tasks.find(t=>t.caseKey==="b").answer.returnedUsdc="500";const out=summarizeResponses([r],expected);assert.equal(out.responses[0].tasks.find(t=>t.caseKey==="b").numericCorrect,false);});
test("four consecutive assigned codes balance case, format and presentation order",()=>{
 const records=[{key:"a"},{key:"b"}],cells=["P001","P002","P003","P004"].map(c=>assignmentFor(c,records));
 assert.equal(new Set(cells.map(c=>c.assignmentCell)).size,4);
 for(const key of ["a","b"])for(const format of ["market_summary","integrated_brief"])
  assert.equal(cells.flatMap(c=>c.queue).filter(t=>t.record.key===key&&t.format===format).length,2);
 const out=summarizeResponses(["P001","P002","P003","P004"].map(c=>response(c)),expected);
 assert.equal(out.allFourCellsRepresented,true);assert.equal(out.eligibleResponseFiles,4);
});
test("old versions, forged format assignments and incomplete answers cannot mix into v2 results",()=>{
 const old=response();old.schemaVersion=1;const format=response("P002");format.tasks[0].format=format.tasks[1].format;
 const text=response("P003");text.tasks[0].answer.evidence="";const wrong=response("P004");wrong.tasks[0].token="0xwrong";
 const r=summarizeResponses([old,format,text,wrong],expected);assert.equal(r.eligibleResponseFiles,0);assert.equal(r.excluded.length,4);
});
