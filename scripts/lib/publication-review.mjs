// This exact provider notice contains no review findings or approval. Required
// review decisions and all other comments are still checked by the publisher.
const CODEX_QUOTA_NOTICE='You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).';
const CODEX_AUTHORS=new Set(['chatgpt-codex-connector','chatgpt-codex-connector[bot]']);
const SUMMARY_HEADER=[
  '<!-- codex-pull-request-review-summary -->',
  '## Codex Review Summary',
  'This comment shows the latest Codex review activity on this pull request.',
  '| Review | Status | Commit | Review trigger |',
  '| --- | --- | --- | --- |',
];
const SUMMARY_FOOTER=[
  '<details> <summary>ℹ️ About Codex in GitHub</summary>',
  '<br/>',
  '[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you',
  '- Open a pull request for review',
  '- Mark a draft as ready',
  '- Comment "@codex review" or "@codex security review".',
  'Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.',
  '</details>',
];
const TIMESTAMP='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z';
const SUMMARY_ROW=new RegExp('^\\| (\\p{Extended_Pictographic}(?:\\p{Extended_Pictographic}|\\uFE0F|\\u200D|\\p{Emoji_Modifier}){0,7}) \\*\\*(Code Review|Security Review)\\*\\* \\| (🔄 \\*\\*Running\\*\\* since|✅ \\*\\*Completed\\*\\*|⚠️ \\*\\*Failed\\*\\*) <relative-time datetime="('+TIMESTAMP+')">('+TIMESTAMP+')</relative-time> \\| `([a-f0-9]{7,40})` \\| (PR opened|Manual request|Draft marked ready) \\|$','u');
const isCodex=comment=>CODEX_AUTHORS.has(comment?.author?.login || comment?.user?.login);
export function reviewUnavailableNotice(comment){
  return isCodex(comment) && comment.body?.trim()===CODEX_QUOTA_NOTICE;
}

// Only the complete, known bot status-table template is metadata. A marker,
// author or title alone cannot exempt freeform feedback or appended findings.
function parseReviewSummary(comment,quotaFailure=false){
  if(!isCodex(comment) || typeof comment.body!=='string')return null;
  let lines=comment.body.replace(/\r\n/g,'\n').split('\n').map(line=>line.trim()).filter(Boolean);
  let state;
  const stateLines=lines.filter(line=>line.startsWith('<!-- codex-review-state:'));
  if(stateLines.length){
    if(stateLines.length!==1)return null;
    const match=stateLines[0].match(/^<!-- codex-review-state:v1 (\{.*\}) -->$/);if(!match)return null;
    try{state=JSON.parse(match[1]);}catch{return null;}
    if(Object.keys(state).sort().join('|')!=='code_review|security_review')return null;
    for(const section of Object.values(state)){
      if(!section||Object.keys(section).sort().join('|')!=='commit_sha|has_any_findings|has_unresolved_findings|status')return null;
      const nullableBoolean=value=>value===null||typeof value==='boolean';
      if(![null,'running','completed',...(quotaFailure?['failed']:[])].includes(section.status)||section.commit_sha!==null&&!/^[a-f0-9]{40}$/.test(section.commit_sha)||!nullableBoolean(section.has_any_findings)||!nullableBoolean(section.has_unresolved_findings)||section.has_unresolved_findings===true&&section.status!=='failed')return null;
      if(section.status==='failed'&&(section.has_any_findings!==true||section.has_unresolved_findings!==true))return null;
      if(section.status==='completed'&&(section.has_unresolved_findings!==false||typeof section.has_any_findings!=='boolean'))return null;
    }
    lines=lines.filter(line=>line!==stateLines[0]);
  }
  const rowCount=lines.length-SUMMARY_HEADER.length-SUMMARY_FOOTER.length;
  if(rowCount<1 || rowCount>2)return null;
  if(SUMMARY_HEADER.some((line,i)=>lines[i]!==line) || SUMMARY_FOOTER.some((line,i)=>lines[lines.length-SUMMARY_FOOTER.length+i]!==line))return null;
  const rows=[];
  for(const line of lines.slice(SUMMARY_HEADER.length,-SUMMARY_FOOTER.length)){
    const match=SUMMARY_ROW.exec(line);
    if(!match || match[4]!==match[5] || !Number.isFinite(Date.parse(match[4])))return null;
    const review=match[2]==='Code Review'?'code':'security';
    if(rows.some(row=>row.review===review))return null;
    const status=match[3].startsWith('🔄')?'running':match[3].startsWith('⚠️')?'failed':'completed';if(status==='failed'&&!quotaFailure)return null;
    rows.push({review,status,at:match[4],commit:match[6],trigger:match[7]});
  }
  if(state)for(const row of rows){const section=state[row.review==='code'?'code_review':'security_review'];if(section.status!==row.status||!section.commit_sha?.startsWith(row.commit))return null;}
  if(state)for(const [key,section]of Object.entries(state))if(section.status!==null&&!rows.some(row=>row.review===(key==='code_review'?'code':'security')))return null;
  return {rows,...(quotaFailure?{structuredFailure:state?.code_review?.status==='failed'}:{})};
}
export const codexReviewSummary=comment=>parseReviewSummary(comment);

function quotaFailureSummary(comment,comments){
  const summary=parseReviewSummary(comment,true);
  if(!summary?.structuredFailure||summary.rows.length!==1||summary.rows[0].review!=='code'||summary.rows[0].status!=='failed')return null;
  const at=Date.parse(summary.rows[0].at);
  // The provider's exact quota notice must immediately follow this failure.
  // An old quota notice cannot dismiss a later failure or a pending review.
  const paired=comments.some(value=>{const gap=Date.parse(value.createdAt||value.created_at)-at;return reviewUnavailableNotice(value)&&gap>=0&&gap<=120_000;});
  return paired?summary:null;
}

function summaryState(row,headSha,resolvedCommits){
  if(row.status==='running')return 'running';
  if(!/^[a-f0-9]{40}$/.test(headSha || '') || !headSha.startsWith(row.commit))return 'stale';
  // GitHub summaries display an abbreviated SHA. Prefix equality alone is not
  // exact-head evidence: the publisher resolves it through the commits API.
  const resolved=row.commit.length===40?row.commit:resolvedCommits.get(row.commit);
  if(!resolved)return 'unresolved';
  return resolved===headSha?'completed':'stale';
}

export function publicationFeedback(comments,{headSha,resolvedCommits=new Map()}={}){
  const feedback={actionable:[],pending:[],summaries:[],unavailable:false};
  for(const comment of comments || []){
    if(reviewUnavailableNotice(comment)){feedback.unavailable=true;continue;}
    // Preserve the existing deployment-notification exception; review bots do
    // not receive an author-wide exception.
    if(comment?.author?.login==='cloudflare-workers-and-pages')continue;
    const quotaFailure=quotaFailureSummary(comment,comments);
    if(quotaFailure){feedback.unavailable=true;feedback.summaries.push({rows:quotaFailure.rows.map(row=>({...row,state:'unavailable'}))});continue;}
    const summary=codexReviewSummary(comment);
    if(!summary){feedback.actionable.push(comment);continue;}
    const rows=summary.rows.map(row=>({...row,state:summaryState(row,headSha,resolvedCommits)}));
    feedback.summaries.push({rows});
    feedback.pending.push(...rows.filter(row=>row.state!=='completed'));
  }
  return feedback;
}
