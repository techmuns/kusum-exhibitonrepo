import {createHash} from 'node:crypto';
export const MARKETS=['haps-maps-aerostats','technical-tapes','tpu-coated-fabric','cbrn-colpro','parachute-systems','carbon-fibre'];
export const digest=s=>createHash('sha256').update(s).digest('hex');
export const text=s=>String(s??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&#(?:x([a-f0-9]+)|(\d+));/gi,(_,h,d)=>String.fromCodePoint(parseInt(h||d,h?16:10))).replace(/&(amp|quot|apos|lt|gt|nbsp|ndash|mdash|rsquo);/g,(_,k)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',rsquo:"'"})[k]).replace(/\s+/g,' ').trim();
export function publicUrl(s,base){if(typeof s!=='string'||!s.trim())return null;try{const u=new URL(s,base);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)?u.href:null;}catch{return null;}}
export const iso=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s?s:null;
const norm=s=>text(s).toLowerCase().replace(/\b20\d{2}\b/g,'').replace(/[^a-z0-9]/g,'');
export function links(html,base){return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>({url:publicUrl(text(m[1]),base),label:text(m[2])})).filter(r=>r.url);}
export function structuredEvents(html,source){
 const out=[];const walk=x=>{if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(walk);return;}if([x['@type']].flat().some(t=>['Event','BusinessEvent','ExhibitionEvent','ConferenceEvent'].includes(t))&&x.name){
  const start=iso(x.startDate?.slice(0,10)),end=iso(x.endDate?.slice(0,10));
  if(start&&(!end||end>=start))out.push({name:text(x.name),start,end,dates:end&&end!==start?`${start} – ${end}`:start,place:text(x.location?.address?.addressLocality||x.location?.name||''),country:text(x.location?.address?.addressCountry?.name||x.location?.address?.addressCountry||''),website:publicUrl(x.url||source.url,source.url),registration:publicUrl(x.offers?.url||x.offers?.[0]?.url,source.url),event_status:/Cancelled/.test(x.eventStatus)?'cancelled':/Postponed/.test(x.eventStatus)?'postponed':'scheduled',evidence:text(JSON.stringify({name:x.name,startDate:x.startDate,endDate:x.endDate,eventStatus:x.eventStatus})).slice(0,650)});
 }for(const [k,v]of Object.entries(x))if(k!=='@context')walk(v);};
 for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{walk(JSON.parse(m[1]));}catch{/* Other page scripts do not establish events. */}}
 return out;
}
export function directoryEvents(html,source){
 if(source.adapter!=='eventseye')return structuredEvents(html,source);
 const out=[];
 for(const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);if(cells.length!==4)continue;
  const name=cells[0].match(/<b>([\s\S]*?)<\/b>/i),link=links(cells[0],source.url)[0],date=text(cells[3]).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d+) days?$/i);
  const description=text(cells[0].match(/<i>([\s\S]*?)<\/i>/i)?.[1]||'');
  if(!name||!link||!date||!new RegExp(source.subject,'i').test(text(name[1])+' '+description))continue;
  const start=iso(`${date[3]}-${date[1]}-${date[2]}`),days=Number(date[4]);if(!start||days<1||days>21)continue;
  const end=new Date(Date.parse(start)+(days-1)*86400000).toISOString().slice(0,10),location=links(cells[2],source.url).find(l=>/\([^)]*\)/.test(l.label))?.label||text(cells[2]);
  out.push({name:text(name[1]),start,end,dates:`${start} – ${end}`,place:location,country:location.match(/\(([^)]+)\)/)?.[1]||'',website:null,listing:link.url,registration:null,event_status:'scheduled',evidence:`${text(name[1])}; ${description}; ${text(cells[3])}`.slice(0,650)});
 }
 return out;
}
const month=s=>{const n=Number(s);return n>=1&&n<=12?n:['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(String(s).toLowerCase().slice(0,3))+1;};
export function reviewedEvent(html,source,{today=new Date().toISOString().slice(0,10)}={}){
 const body=text(html);if(source.identity&&!new RegExp(source.identity,'i').test(body))throw Error('Event identity missing from source');
 const structured=structuredEvents(html,source).filter(r=>norm(r.name)===norm(source.name)&&(r.end||r.start)>=today);
 let event=structured.sort((a,b)=>a.start.localeCompare(b.start))[0];
 if(!event&&source.date_pattern){
  const match=body.match(new RegExp(source.date_pattern,'i')),g=match?.groups;
  if(g){const date=(d,m,y)=>iso(`${y}-${String(month(m)).padStart(2,'0')}-${String(d).padStart(2,'0')}`),start=date(g.from,g.month,g.year),end=date(g.to||g.from,g.month2||g.month,g.year2||g.year);
   if(start&&end&&end>=start&&Date.parse(end)-Date.parse(start)<=30*86400000)event={name:source.name,start,end,dates:`${start} – ${end}`,evidence:match[0],event_status:'scheduled'};
  }
 }
 if(!event&&source.announcement_pattern){const m=body.match(new RegExp(source.announcement_pattern,'i'));if(m)event={name:source.name,start:null,end:null,dates:m[0],evidence:m[0],event_status:'dates-pending'};}
 if(!event||event.start&&(event.end||event.start)<today)return [];
 const candidates=links(html,source.url),registration=candidates.find(l=>new RegExp(source.registration_label||'^(?:Register(?: now| to attend)?|Become a Visitor|Visitor registration|Get (?:free )?tickets?)$','i').test(l.label));
 let destination=registration?.url||event.registration||null;
 // Old edition portals remain in history; do not offer them as current tickets.
 const year=event.start?.slice(0,4),full=destination?.match(/\b(20\d{2})\b/g)||[],short=destination?.match(/[a-z]{3,}(\d{2})(?=registration|tickets?|[/.]|$)/i)?.[1];
 if(year&&(full.some(y=>y!==year)||short&&'20'+short!==year))destination=null;
 return [{...event,name:event.name||source.name,place:source.place||event.place,country:source.country||event.country,website:source.website||source.url,registration:destination}];
}
export async function readPage(url,{fetcher=fetch,limit=2_000_000}={}){
 if(!publicUrl(url))throw Error('Invalid public source URL');
 let r,current=url;for(let redirects=0;redirects<=3;redirects++){
  r=await fetcher(current,{redirect:'manual',signal:AbortSignal.timeout(18000),headers:{'user-agent':'Kusumgar-Exhibition-Calendar/1.0 (public event dates)'}});
  if(![301,302,303,307,308].includes(r.status))break;
  const next=publicUrl(r.headers.get('location'),current);await r.body?.cancel();
  if(!next||new URL(next).hostname.replace(/^www\./,'')!==new URL(url).hostname.replace(/^www\./,''))throw Error('Source redirects outside its approved host');current=next;
 }
 if(!r.ok)throw Error(`HTTP ${r.status}`);if(!/html|json|calendar|xml|text/.test(r.headers.get('content-type')||''))throw Error('Unsupported source format');
 const reader=r.body.getReader(),parts=[];let n=0;for(;;){const {value,done}=await reader.read();if(done)break;n+=value.byteLength;if(n>limit){await reader.cancel();throw Error('Source exceeds 2 MB budget');}parts.push(value);}const bytes=new Uint8Array(n);let i=0;for(const p of parts){bytes.set(p,i);i+=p.length;}return new TextDecoder().decode(bytes);
}
export async function refreshCatalogue(shows,ledger,config,{now=new Date().toISOString(),limit=24,read=readPage,budgetMs=300000}={}){
 const started=Date.now();ledger.sources||={};const byId=new Map(shows.map(r=>[r.id,r]));let added=0,updated=0,failed=0,reads=0;
 const queue=[...config.sources].sort((a,b)=>String(ledger.sources[a.id]?.attempted_at||'').localeCompare(ledger.sources[b.id]?.attempted_at||''));
 for(const source of queue){if(reads>=limit||Date.now()-started>=budgetMs)break;const old=ledger.sources[source.id]||{};reads++;
  try{const html=await read(source.url),events=source.adapter==='reviewed'?reviewedEvent(html,source,{today:now.slice(0,10)}):directoryEvents(html,source);if(!events.length)throw Error('No supported next-edition dates or announcement extracted; last-good data retained');
   for(const event of events){
    const series=source.show_id||'public-'+digest((event.listing||event.website||'')+'|'+norm(event.name)).slice(0,16),id=source.show_id||series+'-'+event.start;
    const prior=byId.get(id),receipt={source_id:source.id,url:source.url,content_sha256:digest(html),checked_at:now,excerpt:event.evidence,attribution:source.adapter==='eventseye'?'directory-reported':'organiser-reported'};
    const next={...prior,...event,id,segment:source.segment||'Industrial',market_ids:source.markets,relevance_reason:source.relevance,status:prior?.status||'Not yet',source:'public-calendar',discovered_at:prior?.discovered_at||now,source_checked_at:now,date_evidence:receipt,registration_status:event.registration?'published':'not-published',previous_editions:prior?.previous_editions||[]};
    delete next.evidence;
    if(prior&&['name','start','end','dates','website','registration','place','event_status'].some(k=>prior[k]!==next[k])){const {previous_editions,...previous}=prior;next.previous_editions=[...next.previous_editions,previous];}
    if(prior)updated++;else added++;byId.set(id,next);
   }
   ledger.sources[source.id]={...old,url:source.url,markets:source.markets,attempted_at:now,last_success_at:now,status:'success',accepted:events.length,error:null};
  }catch(error){failed++;ledger.sources[source.id]={...old,url:source.url,markets:source.markets,attempted_at:now,status:'failed',error:String(error.message).slice(0,180)};}
 }
 ledger.last_run={attempted_at:now,reads,added,updated,failed,status:failed?'partial':'success'};
 return {shows:[...byId.values()],ledger};
}
