import {fixtureFor,cases} from "../tests/helpers/fixture-fetcher.mjs";
const chosen=cases.find(c=>c.selection===(process.env.SIGNALPROOF_FIXTURE_CASE??"established_control"));
if(!chosen)throw Error("Unknown recorded test case");
globalThis.fetch=(await fixtureFor(chosen)).fetcher;
