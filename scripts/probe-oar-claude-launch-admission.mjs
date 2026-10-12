/** Disposable #229 complete pinned OAR launch capture and MCP capability controls. */
import { registerHooks, createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { makeOriginFixture } from './prototype-origin-fixture.mjs';
const fixture=makeOriginFixture(),facts={evidenceClass:'scripted pinned argument-builder execution and native MCP protocol controls',launches:[],mcp:[]};
const children=new Set();const deadline=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');},90000);
try{
 const root=resolve(process.env.OAR_PROBE_ROOT||'missing-oar-prerequisite');
 if(JSON.parse(readFileSync(join(root,'package.json'))).version!=='0.35.0')throw Error('pin-drift');
 const require=createRequire(join(resolve(process.env.OAR_PROBE_DEPS||process.cwd()),'package.json'));
 const dependencies=Object.fromEntries(['cross-spawn','which'].map(n=>[n,pathToFileURL(require.resolve(n)).href]));
 registerHooks({resolve(s,c,next){if(dependencies[s])return {url:dependencies[s],shortCircuit:true};return next(s,c);}});
 const {launchClaude}=await import(pathToFileURL(join(root,'dist/runtimes/claude/launch.js')));
 const control=join(fixture.root,'control');mkdirSync(control);const capture=join(control,'capture');
 const wrapper=join(control,'capture-launch');
 writeFileSync(wrapper,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';const a=process.argv.slice(2);writeFileSync(${JSON.stringify(capture)},JSON.stringify({explicitFlags:['--plugin-url','--plugin-dir','--add-dir','--agents'].filter(f=>a.includes(f)),mcpConfig:a.includes('--mcp-config'),streamInput:a.includes('stream-json'),systemPromptIsSingleArgument:a[a.indexOf('--system-prompt')+1]==='synthetic --plugin-url --add-dir --agents',argumentCount:a.length}));`);chmodSync(wrapper,0o700);
 for(const scenario of ['ordinary','unknown-options']){
  const child=await launchClaude(wrapper,'synthetic-session',{cwd:fixture.host,model:'group/auto-mimo-v2-6-flash[1m]',effort:'high',systemPrompt:'synthetic --plugin-url --add-dir --agents',mcpServers:[],...(scenario==='unknown-options'?{pluginUrl:'synthetic',addDir:'synthetic',agents:{synthetic:{}}}:{})});
  await child.exited;facts.launches.push({scenario,...JSON.parse(readFileSync(capture,'utf8'))});
 }
 const source=readFileSync(join(root,'dist/runtimes/claude/launch.js'));
 facts.launchSha256=createHash('sha256').update(source).digest('hex');
 const positive=join(control,'resource-control.cjs');
 writeFileSync(positive,`require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const q=JSON.parse(l);const r=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{resources:{},prompts:{}},serverInfo:{name:'synthetic-resource-control',version:'1'}}:q.method==='resources/list'?{resources:[{uri:'synthetic:loader',name:'synthetic'}]}:q.method==='prompts/list'?{prompts:[{name:'synthetic',description:'synthetic'}]}:null;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...(r?{result:r}:{error:{code:-32601,message:'unsupported'}})})+'\\n');});`);
 for(const mode of ['positive','approved-bridge']){
  const child=spawn(process.execPath,[mode==='positive'?positive:join(import.meta.dirname,'prototype-claude-fixture-bridge.mjs'),'synthetic-unused-endpoint'],{stdio:['pipe','pipe','ignore']});children.add(child);let data='';child.stdout.on('data',c=>data+=c);const exited=new Promise(r=>child.on('exit',r));
  const queries=[{id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},{id:2,method:'resources/list'},{id:3,method:'prompts/list'}];
  child.stdin.end(queries.map(q=>JSON.stringify({jsonrpc:'2.0',...q})).join('\n')+'\n');const code=await exited;children.delete(child);
  const replies=data.trim().split('\n').map(l=>JSON.parse(l));const init=replies.find(r=>r.id===1)?.result;
  facts.mcp.push({mode,exitCode:code,capabilities:Object.keys(init?.capabilities??{}).sort(),resourceListing:replies.find(r=>r.id===2)?.result?.resources?.length===1,promptListing:replies.find(r=>r.id===3)?.result?.prompts?.length===1,resourcesRejected:replies.find(r=>r.id===2)?.error?.code===-32601,promptsRejected:replies.find(r=>r.id===3)?.error?.code===-32601});
 }
 facts.sentinelUnchanged=readFileSync(join(fixture.outside,'sentinel.txt'),'utf8')==='HOST_SENTINEL_UNCHANGED';
}catch(e){facts.blocker=e.message==='pin-drift'?'pin-drift':'launch-or-capability-control-unavailable';}
finally{for(const c of children)c.kill('SIGKILL');clearTimeout(deadline);fixture.cleanup();writeFileSync('docs/research/oar-claude-rework2-admission-evidence.json',JSON.stringify(facts,null,2)+'\n');console.log(JSON.stringify(facts));}
