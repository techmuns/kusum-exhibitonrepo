import {codexReviewSummary,publicationFeedback,reviewUnavailableNotice} from './publication-review.mjs';
import {flattenCheckPages,flattenStatusPages,publicationChecks,requiredCheckResult} from './publication-checks.mjs';

export async function finalizePublication({gh,repo,prUrl,sha,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=console.log,timeoutMs=10*60000}={}){
  const started=now(),deadline=started+timeoutMs,resolvedReviewCommits=new Map();
  let sawUnavailable=false;
  for(;;){
    const pr=JSON.parse(gh('pr','view',prUrl,'--json','headRefOid,state,mergeable,reviewDecision,reviewRequests,reviews,comments'));
    sawUnavailable ||= pr.comments.some(reviewUnavailableNotice);
    if(pr.headRefOid!==sha)throw Error('PR head changed; leave open for review.');
    if(pr.state==='MERGED'){log('Scheduled data PR is already merged.');return;}
    if(pr.state!=='OPEN')throw Error('PR is no longer open.');
    if(pr.reviewDecision==='CHANGES_REQUESTED'||pr.reviewDecision==='REVIEW_REQUIRED'||pr.reviewRequests.length||pr.reviews.some(r=>r.state==='CHANGES_REQUESTED'))throw Error('Review gate requires attention; leave PR open.');
    let required=[];
    try{required=requiredCheckResult({stdout:gh('pr','checks',prUrl,'--required','--json','name,state')});}
    catch(error){required=requiredCheckResult({stdout:error.stdout,stderr:error.stderr,exitCode:error.status});}
    const checkRuns=flattenCheckPages(JSON.parse(gh('api',`repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`,'--paginate','--slurp')));
    const statuses=flattenStatusPages(JSON.parse(gh('api',`repos/${repo}/commits/${sha}/statuses?per_page=100`,'--paginate','--slurp')));
    const gate=publicationChecks({headSha:sha,checkRuns,statuses,required});
    if(gate.failed.length)throw Error(`A check failed (${gate.failed.map(c=>c.name).join(', ')}); leave PR open.`);
    const number=prUrl.split('/').at(-1);
    const comments=JSON.parse(gh('api',`repos/${repo}/pulls/${number}/comments`));
    if(comments.length)throw Error('Inline review feedback requires attention; leave PR open.');
    for(const comment of pr.comments)for(const row of codexReviewSummary(comment)?.rows||[]){
      if(row.status!=='completed'||row.commit.length===40||!sha.startsWith(row.commit)||resolvedReviewCommits.has(row.commit))continue;
      try{const resolved=gh('api',`repos/${repo}/commits/${row.commit}`,'--jq','.sha');if(/^[a-f0-9]{40}$/.test(resolved))resolvedReviewCommits.set(row.commit,resolved);}catch{/* No ambiguous abbreviation becomes approval. */}
    }
    const feedback=publicationFeedback(pr.comments,{headSha:sha,resolvedCommits:resolvedReviewCommits});
    if(feedback.actionable.length)throw Error('PR feedback requires attention; leave PR open.');
    if(pr.mergeable==='CONFLICTING')throw Error('Merge conflict; leave PR open.');
    // Keep the reviewer response window, now independent of CI duration. Always
    // reconcile once after the last sleep, even if it crosses the deadline.
    if(gate.ready&&!feedback.pending.length&&pr.mergeable==='MERGEABLE'&&now()-started>=2*60000){
      if(feedback.unavailable)log('Automated code review unavailable: provider quota exhausted. No approval inferred; required-review gates still apply.');
      gh('pr','merge',prUrl,'--squash','--match-head-commit',sha);
      log('Research PR merged. Deployment remains owned by the existing Git integration.');return;
    }
    if(now()>=deadline)throw Error(`Checks/reviews did not finish; leave PR open for attention.${sawUnavailable?' Automated code review quota was exhausted; no approval was inferred.':''}`);
    await sleep(20000);
  }
}
