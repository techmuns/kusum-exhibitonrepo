import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {refreshCatalogue} from './lib/public-exhibitions.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),read=async p=>JSON.parse(await readFile(root+p,'utf8'));
const shows=await read('public/data/exhibitions.json'),config=await read('scripts/exhibition-sources.json');
const ledger=await read('public/data/exhibition-checks.json').catch(e=>{if(e.code!=='ENOENT')throw e;return {version:1,sources:{}};});
const result=await refreshCatalogue(shows,ledger,config,{limit:Math.min(64,Math.max(1,Number(process.env.MAX)||24))});
for(const [path,value] of [['public/data/exhibitions.json',result.shows],['public/data/exhibition-checks.json',result.ledger]])await writeFile(root+path,JSON.stringify(value,null,1)+'\n');
console.log(result.ledger.last_run);
