// Normalize executed checks from the exact commit's REST endpoints. PR rollups
// can omit dispatched workflows and are not execution evidence for publication.
const fullSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const name=value=>typeof value==='string'&&value.trim()?value.trim():null;
const id=value=>Number.isSafeInteger(value)&&value>0?value:null;
const upper=value=>typeof value==='string'?value.toUpperCase():'';
const preview='Workers Builds: kusumgarcr';
const failures=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE','STALE']);
const completed=new Set(['SUCCESS','NEUTRAL','SKIPPED']);

export function requiredCheckResult({stdout='',stderr='',exitCode=0}={}){
  // gh uses 1 for failed checks and 8 for pending checks. Structured output
  // still supplies required names; only their execution state is reconciled.
  if([1,8].includes(exitCode)&&!String(stdout).trim()&&/\bno (required )?checks reported\b/i.test(String(stderr)))return [];
  if(![0,1,8].includes(exitCode))throw Error('Required check query failed');
  let result;try{result=JSON.parse(String(stdout));}catch{throw Error('Required check query did not return structured evidence');}
  if(!Array.isArray(result)||result.some(r=>!name(r?.name)||!name(r?.state)))throw Error('Invalid required check response');
  if(exitCode!==0&&!result.length)throw Error('Required check query failed without check evidence');
  return result;
}

export function flattenCheckPages(pages){
  if(!Array.isArray(pages)||!pages.length||pages.some(p=>!p||!Array.isArray(p.check_runs)||!Number.isSafeInteger(p.total_count)||p.total_count<0))throw Error('Invalid paginated commit check response');
  const rows=pages.flatMap(p=>p.check_runs),total=pages[0].total_count;
  if(pages.some(p=>p.total_count!==total)||rows.length!==total||new Set(rows.map(r=>r?.id)).size!==total)throw Error('Incomplete paginated commit check response');
  return rows;
}
export function flattenStatusPages(pages){
  if(!Array.isArray(pages)||!pages.length||pages.some(p=>!Array.isArray(p)))throw Error('Invalid paginated commit status response');
  return pages.flat();
}

function checkState(row){
  const status=upper(row.status),conclusion=upper(row.conclusion);
  if(status!=='COMPLETED')return 'pending';
  if(failures.has(conclusion))return 'failed';
  return completed.has(conclusion)?'completed':'pending';
}
function statusState(row){const state=upper(row.state);return state==='SUCCESS'?'completed':failures.has(state)?'failed':'pending';}

export function publicationChecks({headSha,checkRuns=[],statuses=[],required=[]}={}){
  if(!fullSha(headSha)||!Array.isArray(checkRuns)||!Array.isArray(statuses)||!Array.isArray(required))throw Error('Invalid publication check evidence');
  const requiredNames=new Set(required.map(r=>{const value=name(r?.name);if(!value)throw Error('Invalid required check name');return value;}));
  const latest=new Map();
  const remember=row=>{
    const prior=latest.get(row.key);
    // IDs identify attempt creation order. Completion times must not let a slow
    // old failed attempt supersede a newer successful rerun (or pending rerun).
    if(!prior||row.id>prior.id)latest.set(row.key,row);
    else if(row.id===prior.id&&JSON.stringify(row)!==JSON.stringify(prior))throw Error('Conflicting duplicate check evidence');
  };
  for(const row of checkRuns){
    if(!row||!fullSha(row.head_sha))throw Error('Commit check is missing its head SHA');
    if(row.head_sha!==headSha)continue;
    const checkName=name(row.name),checkId=id(row.id),appId=id(row.app?.id),appSlug=name(row.app?.slug);
    if(!checkName||!checkId||(!appId&&!appSlug))throw Error('Commit check identity is incomplete');
    remember({key:`check:${appId||appSlug}:${checkName}`,kind:'check',id:checkId,name:checkName,app:appSlug,appId,state:checkState(row),conclusion:upper(row.conclusion),status:upper(row.status),headSha});
  }
  for(const row of statuses){
    if(!row)throw Error('Invalid commit status');
    // REST statuses need not contain a sha: the publisher reads the endpoint
    // pinned to headSha. Reject an explicit conflicting SHA when one is given.
    const explicit=row.sha||row.head_sha;
    if(explicit&&!fullSha(explicit))throw Error('Invalid commit status SHA');
    if(explicit&&explicit!==headSha)continue;
    const context=name(row.context),statusId=id(row.id);
    if(!context||!statusId)throw Error('Commit status identity is incomplete');
    remember({key:`status:${context}`,kind:'status',id:statusId,name:context,state:statusState(row),conclusion:upper(row.state),headSha});
  }
  const checks=[...latest.values()].sort((a,b)=>a.key.localeCompare(b.key));
  // This is the existing optional preview exception. Application jobs or
  // required preview checks cannot acquire it by choosing the same check name.
  const ignored=checks.filter(c=>c.kind==='check'&&c.name===preview&&c.app==='cloudflare-workers-and-pages'&&!requiredNames.has(c.name));
  const ignoredKeys=new Set(ignored.map(c=>c.key)),gating=checks.filter(c=>!ignoredKeys.has(c.key));
  const failed=gating.filter(c=>c.state==='failed'),pending=gating.filter(c=>c.state==='pending');
  const missingRequired=[...requiredNames].filter(context=>!checks.some(c=>c.name===context));
  const incompleteRequired=gating.filter(c=>requiredNames.has(c.name)&&c.conclusion!=='SUCCESS');
  const validated=gating.some(c=>c.kind==='check'&&c.name==='validate'&&c.app==='github-actions'&&c.status==='COMPLETED'&&c.conclusion==='SUCCESS');
  return {checks,gating,ignored,failed,pending,missingRequired,incompleteRequired,validated,
    ready:validated&&!failed.length&&!pending.length&&!missingRequired.length&&!incompleteRequired.length};
}
