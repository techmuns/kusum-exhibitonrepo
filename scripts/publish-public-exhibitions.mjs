import {execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {finalizePublication} from './lib/finalize-publication.mjs';
const run=(bin,...args)=>execFileSync(bin,args,{encoding:'utf8'}).trim(),gh=(...args)=>run('gh',...args),git=(...args)=>run('git',...args),repo=process.env.GITHUB_REPOSITORY;
const files=['public/data/exhibitions.json','public/data/exhibition-checks.json','public/data/meta.json'];
if(process.argv.includes('--finalize')){
 const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));if(!Number.isSafeInteger(event.workflow_run?.id))throw Error('Missing completion identity');
 const r=JSON.parse(gh('api',`repos/${repo}/actions/runs/${event.workflow_run.id}`));
 if(!r||r.name!=='Exhibition checks'||r.path!=='.github/workflows/exhibition-checks.yml'||r.event!=='workflow_dispatch'||r.status!=='completed'||r.conclusion!=='success'||r.repository?.full_name!==repo||r.head_repository?.full_name!==repo||!/^codex\/exhibition-refresh-\d+$/.test(r.head_branch))process.exit(0);
 const prs=JSON.parse(gh('api',`repos/${repo}/pulls?state=open&head=${repo.split('/')[0]}:${r.head_branch}`));
 if(prs.length!==1)process.exit(0);const pr=prs[0];
 if(pr.head.sha!==r.head_sha||pr.head.repo.full_name!==repo||pr.base.ref!=='main'||pr.user.login!=='github-actions[bot]'||pr.draft)throw Error('Publication identity changed');
 const changes=JSON.parse(gh('api',`repos/${repo}/pulls/${pr.number}/files?per_page=100`,'--paginate','--slurp')).flat();
 if(changes.length!==pr.changed_files||changes.some(f=>!files.includes(f.filename)||!['added','modified'].includes(f.status)))throw Error('Publication scope changed');
 await finalizePublication({gh,repo,prUrl:pr.html_url,sha:r.head_sha});
}else{
 if(process.env.GITHUB_REF_NAME!=='main'||!/^\d+$/.test(process.env.GITHUB_RUN_ID||''))throw Error('Only scheduled main data may be published');
 if(!git('status','--porcelain','--',...files))process.exit(0);
 const branch=`codex/exhibition-refresh-${process.env.GITHUB_RUN_ID}`;
 git('switch','-c',branch);git('config','user.name','github-actions[bot]');git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com');git('add',...files);git('commit','-m','Refresh public exhibition dates and source receipts');git('push','-u','origin',branch);
 writeFileSync('.exhibition-pr-body.md','Refresh the shared exhibition catalogue from bounded direct public sources. Source failures retain last-good records; event editions retain previous dates and evidence. No paid extraction, outreach or Signals collection.\n\nValidation: Exhibition checks on this exact head. Automated approval is not assumed; required checks and review gates must pass.\n');
 const url=gh('pr','create','--repo',repo,'--base','main','--head',branch,'--title','Refresh public exhibition calendar','--body-file','.exhibition-pr-body.md');console.log(url);
 gh('workflow','run','exhibition-checks.yml','--repo',repo,'--ref',branch);
}
