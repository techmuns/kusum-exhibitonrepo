import test from 'node:test';
import assert from 'node:assert/strict';
import {codexReviewSummary,publicationFeedback,reviewUnavailableNotice} from './lib/publication-review.mjs';

const HEAD='7b2126bb055ceaff7103824352fa19db735bf7f4';
const PREVIOUS_HEAD='7226162c1cfb0d6ad7c661c1216a86acddec529c';
const AT='2026-10-06T16:53:17.404047Z';
const quota='You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).';
const bot=body=>({author:{login:'chatgpt-codex-connector'},body});
const row=({review='Code Review',icon='📝',status='Running',commit=HEAD.slice(0,7),trigger='Manual request',at=AT}={})=>`| ${icon} **${review}** | ${status==='Running'?'🔄 **Running** since':'✅ **Completed**'} <relative-time datetime="${at}">${at}</relative-time> | \`${commit}\` | ${trigger} |`;
// This header/footer and the Code Review rows match the live PR133/PR132 bot
// comments. The Security Review fixture is synthetic; its label is recognized,
// and a bounded presentation emoji does not change its gate semantics.
const summary=(rows=[row()])=>`<!-- codex-pull-request-review-summary -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
${rows.join('\n')}



<details> <summary>ℹ️ About Codex in GitHub</summary>
<br/>

[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
- Open a pull request for review
- Mark a draft as ready
- Comment "@codex review" or "@codex security review".

Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.

</details>`;
const classify=(comments,headSha=HEAD,resolvedCommits=new Map())=>publicationFeedback(comments,{headSha,resolvedCommits});

test('the live Running summary waits, and the live Completed row needs a resolved exact head',()=>{
  const running=classify([bot(summary())]);
  assert.equal(running.actionable.length,0);
  assert.deepEqual(running.pending.map(r=>r.state),['running']);
  const completed=bot(summary([row({status:'Completed',commit:PREVIOUS_HEAD.slice(0,7),trigger:'PR opened',at:'2026-10-06T16:09:01.184716Z'})]));
  assert.deepEqual(classify([completed],PREVIOUS_HEAD).pending.map(r=>r.state),['unresolved']);
  const exact=classify([completed],PREVIOUS_HEAD,new Map([[PREVIOUS_HEAD.slice(0,7),PREVIOUS_HEAD]]));
  assert.equal(exact.actionable.length,0);
  assert.equal(exact.pending.length,0);
  assert.equal(exact.summaries[0].rows[0].state,'completed');
});
test('current structured bot state must agree with rendered rows and cannot hide unresolved or pending reviews',()=>{
  const blank={commit_sha:null,has_any_findings:null,has_unresolved_findings:null,status:null};
  const state={code_review:{commit_sha:HEAD,has_any_findings:false,has_unresolved_findings:false,status:'completed'},security_review:blank};
  const body=value=>summary([row({status:'Completed',commit:HEAD})]).replace('<!-- codex-pull-request-review-summary -->','<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+JSON.stringify(value)+' -->');
  assert.equal(classify([bot(body(state))]).actionable.length,0);
  for(const changed of [
    {...state,code_review:{...state.code_review,has_unresolved_findings:true}},
    {...state,code_review:{...state.code_review,commit_sha:PREVIOUS_HEAD}},
    {...state,code_review:{...state.code_review,status:'running'}},
    {...state,security_review:{...state.code_review,status:'running'}},
    {...state,extra:'[P1] Hidden finding'},
  ])assert.equal(classify([bot(body(changed))]).actionable.length,1);
  assert.equal(classify([bot(body(state)+'\n[P1] Correct the company match.')]).actionable.length,1);
});

test('a completed older-head summary or a short-SHA collision does not release publication',()=>{
  const stale=bot(summary([row({status:'Completed',commit:'79cfdf5'})]));
  assert.deepEqual(classify([stale]).pending.map(r=>r.state),['stale']);
  const current=bot(summary([row({status:'Completed'})]));
  const differentFullSha=HEAD.slice(0,7)+'0'.repeat(33);
  assert.deepEqual(classify([current],HEAD,new Map([[HEAD.slice(0,7),differentFullSha]])).pending.map(r=>r.state),['stale']);
  assert.deepEqual(classify([current],HEAD,new Map([[HEAD.slice(0,7),'not-a-commit']])).pending.map(r=>r.state),['stale']);
});

test('a full current SHA can prove completed metadata without an abbreviation lookup',()=>{
  const result=classify([bot(summary([row({status:'Completed',commit:HEAD})]))]);
  assert.equal(result.pending.length,0);
  assert.equal(result.actionable.length,0);
  assert.equal(result.unavailable,false);
  assert.deepEqual(classify([bot(summary([row({status:'Completed',commit:HEAD})]))],'').pending.map(r=>r.state),['stale']);
});

test('all Code and Security Review rows must complete on the exact head',()=>{
  const code=row({status:'Completed'}),security=row({review:'Security Review',icon:'🔒',status:'Completed'});
  const resolved=new Map([[HEAD.slice(0,7),HEAD]]);
  const done=classify([bot(summary([code,security]))],HEAD,resolved);
  assert.equal(done.pending.length,0);
  assert.deepEqual(done.summaries[0].rows.map(r=>r.review),['code','security']);
  for(const incomplete of [
    row({review:'Security Review',icon:'🛡️'}),
    row({review:'Security Review',icon:'🔒',status:'Completed',commit:PREVIOUS_HEAD.slice(0,7)}),
    row({review:'Security Review',icon:'🔒',status:'Completed',commit:HEAD.slice(0,8)}),
  ])assert.equal(classify([bot(summary([code,incomplete]))],HEAD,resolved).pending.length,1);
});

test('metadata exemption requires the trusted provider identity, in GH or REST shape',()=>{
  const body=summary([row({status:'Completed',commit:HEAD})]);
  assert.equal(classify([{user:{login:'chatgpt-codex-connector[bot]'},body}]).pending.length,0);
  assert.equal(classify([{user:{login:'chatgpt-codex-connector[bot]'},body}]).actionable.length,0);
  for(const login of ['someone-else','chatgpt-codex-connector-copy','github-actions[bot]'])assert.equal(classify([{author:{login},body}]).actionable.length,1);
  assert.equal(classify([{author:{login:'someone-else'},user:{login:'chatgpt-codex-connector[bot]'},body}]).actionable.length,1);
});

test('findings appended to a known summary and freeform bot comments remain actionable',()=>{
  const known=summary([row({status:'Completed',commit:HEAD})]);
  for(const body of [known+'\n[P1] Preserve source evidence.',known.replace('</details>','[P2] Correct product scope.\n</details>'),'<!-- codex-pull-request-review-summary -->\n[P1] Fix the data leak.','[P1] Fix the data leak.']){
    assert.equal(codexReviewSummary(bot(body)),null);
    assert.equal(classify([bot(body)]).actionable.length,1);
  }
  const mixed=classify([bot(known),bot('[P1] Fix the data leak.')]);
  assert.equal(mixed.pending.length,0);
  assert.equal(mixed.actionable.length,1);
});

test('unknown summary labels, status, malformed timestamps or template changes fail closed',()=>{
  const known=summary([row({status:'Completed',commit:HEAD})]);
  for(const body of [
    summary([row({review:'Documentation Review',status:'Completed',commit:HEAD})]),
    summary([row({status:'Completed',commit:HEAD}),row({status:'Completed',commit:HEAD})]),
    known.replace('✅ **Completed**','⚠️ **Failed**'),
    known.replace('✅ **Completed**','🔄 **Running**'),
    known.replace(`datetime="${AT}"`,'datetime="2026-10-06T16:00:00Z"'),
    known.replaceAll(AT,'not-a-date'),
    known.replace('| Review | Status | Commit | Review trigger |','| Review | Status | Commit | Findings |'),
    known.replace('Codex reacts with 👀','Codex approves this PR and reacts with 👀'),
    known.replace('`'+HEAD+'`','`'+HEAD+' extra`'),
  ])assert.equal(classify([bot(body)]).actionable.length,1);
});

test('the exact quota notice is unavailable evidence, and cannot override pending reviews',()=>{
  assert(reviewUnavailableNotice(bot(quota)));
  assert(reviewUnavailableNotice({user:{login:'chatgpt-codex-connector[bot]'},body:quota}));
  const unavailable=classify([bot(quota)]);
  assert.equal(unavailable.unavailable,true);
  assert.equal(unavailable.summaries.length,0);
  for(const body of [quota+' Fix the data leak.',quota.replace('usage limits','approval')])assert.equal(classify([bot(body)]).actionable.length,1);
  assert.equal(classify([{author:{login:'someone-else'},body:quota}]).actionable.length,1);
  const pending=classify([bot(quota),bot(summary())]);
  assert.equal(pending.unavailable,true);
  assert.deepEqual(pending.pending.map(r=>r.state),['running']);
});


test('exact-head failed status metadata plus a known quota refusal is unavailable, without hiding findings',()=>{
  const head='a'.repeat(40),section={status:'failed',commit_sha:head,has_any_findings:true,has_unresolved_findings:true};
  const state={code_review:section,security_review:{status:null,commit_sha:null,has_any_findings:null,has_unresolved_findings:null}};
  const at='2026-10-19T13:40:56Z';
  const body=['<!-- codex-pull-request-review-summary -->','<!-- codex-review-state:v1 '+JSON.stringify(state)+' -->','## Codex Review Summary','This comment shows the latest Codex review activity on this pull request.','| Review | Status | Commit | Review trigger |','| --- | --- | --- | --- |','| 📝 **Code Review** | ⚠️ **Failed** <relative-time datetime="'+at+'">'+at+'</relative-time> | `aaaaaaa` | PR opened |','<details> <summary>ℹ️ About Codex in GitHub</summary>','<br/>','[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you','- Open a pull request for review','- Mark a draft as ready','- Comment "@codex review" or "@codex security review".','Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.','</details>'].join('\n');
  const comment={author:{login:'chatgpt-codex-connector'},body};
  const quota={author:comment.author,body:'You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).'};
  assert.equal(publicationFeedback([comment,quota],{headSha:head}).actionable.length,0);
  assert(publicationFeedback([comment,quota],{headSha:head}).unavailable);
  assert.equal(publicationFeedback([comment],{headSha:head}).actionable.length,1);
  assert.equal(publicationFeedback([comment,quota],{headSha:'b'.repeat(40)}).actionable.length,1);
  assert.equal(publicationFeedback([{...comment,body:body+'\nCorrect the registration date.'},quota],{headSha:head}).actionable.length,1);
});
