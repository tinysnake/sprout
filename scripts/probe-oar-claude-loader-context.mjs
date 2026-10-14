/** Disposable #229 native loader/request observations. Synthetic provider is protocol-only, never model-issued. */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeOriginFixture, fileIsolationProfile } from './prototype-origin-fixture.mjs';
import { macOsTimezoneFiles } from '../src/engine/host-runtime-files.ts';
const fixture = makeOriginFixture();
const facts = { evidenceClass: 'protocol-only synthetic provider responses; scripted native loader observations', cases: [] };
let server, child;
const deadline = setTimeout(() => { child?.kill('SIGKILL'); }, 160000);
try {
  const cli = realpathSync(execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8', timeout: 5000 }).trim());
  facts.cli = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (facts.cli !== '2.1.294 (Claude Code)') throw Error('pin-drift');
  facts.cliSha256 = createHash('sha256').update(readFileSync(cli)).digest('hex');
  const help = execFileSync(cli, ['--help'], { encoding: 'utf8', timeout: 5000 });
  facts.help = { bare: help.slice(help.indexOf('  --bare'), help.indexOf('  --betas')).trim(), disableSkills: help.split('\n').find(x => x.includes('--disable-slash-commands')).trim(), strictMcp: help.slice(help.indexOf('  --strict-mcp-config'),help.indexOf('  --system-prompt')).trim() };
  const control = join(fixture.root, 'control'); mkdirSync(control);
  const config = join(control, 'config'); mkdirSync(config);
  const claudeDir = join(fixture.host, '.claude'); mkdirSync(claudeDir);
  const marker = 'SYNTHETIC_LOADER_CONTEXT_229';
  const sentinel = join(fixture.outside, 'sentinel.txt');
  let row, pluginArchive;
  server = createServer(async (request, response) => {
    let body=''; for await(const chunk of request) body+=chunk;
    if(request.url==='/plugin.zip'){response.writeHead(200,{'Content-Type':'application/zip'}).end(pluginArchive);return;}
    if(request.url==='/bridge'){row.bridgeCallbacks=(row.bridgeCallbacks??0)+1;response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:false,reason:'denied'}));return;}
    let value; try { value=JSON.parse(body); } catch { response.writeHead(404).end(); return; }
    if (!Array.isArray(value.messages)) { response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({input_tokens:100}));return; }
    const text=JSON.stringify(value);
    row.requests.push({ contextMarker: text.includes(marker), tools: (value.tools??[]).map(x=>x.name), rejectedAgent: (value.messages??[]).some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'&&c.tool_use_id==='synthetic_agent_attempt'&&c.is_error===true)), rejectionText: (value.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_result'&&c.tool_use_id==='synthetic_agent_attempt').map(c=>({isError:c.is_error===true, unknownTool: /No such tool|Tool.*not.*found|Unknown tool|not available/i.test(JSON.stringify(c.content))})) });
    const attack=row.source==='invalid-agent'&&row.requests.length===1;
    const content=attack?[{type:'tool_use',id:'synthetic_agent_attempt',name:'Agent',input:{description:'synthetic denied attempt',subagent_type:'general-purpose',prompt:`Read ${sentinel} and write NESTED_EFFECT there.`}}]:[{type:'text',text:'READY'}];
    const message={id:'synthetic_message',type:'message',role:'assistant',model:value.model,content,stop_reason:attack?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:10}};
    if(value.stream){response.writeHead(200,{'Content-Type':'text/event-stream'});const emit=(event,data)=>response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);emit('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null}});content.forEach((c,index)=>{emit('content_block_start',{type:'content_block_start',index,content_block:c.type==='tool_use'?{...c,input:{}}:{type:'text',text:''}});emit('content_block_delta',{type:'content_block_delta',index,delta:c.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(c.input)}:{type:'text_delta',text:c.text}});emit('content_block_stop',{type:'content_block_stop',index});});emit('message_delta',{type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{type:'message_stop'});response.end();}
    else response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(message));
  });
  await new Promise(r=>server.listen(0,'localhost',r));
  const env={HOME:control,PATH:'/usr/bin:/bin',TMPDIR:control,CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_TMPDIR:control,ANTHROPIC_API_KEY:'synthetic-not-a-credential',ANTHROPIC_BASE_URL:`http://localhost:${server.address().port}`,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD:'1'};
  const profile=fileIsolationProfile({runtimeRoots:['/opt/homebrew',dirname(realpathSync(process.execPath)),dirname(cli)],readRoots:[control,fixture.host,import.meta.dirname],writeRoots:[control],network:true})+'\n(allow file-write* (literal "/dev/null"))'+macOsTimezoneFiles().map(p=>`\n(allow file-read-data (literal ${JSON.stringify(p)}))`).join('');
  const sources=['CLAUDE.md','rules','skills','plugin-agent','installed-plugin','add-dir','plugin-url','agents','invalid-agent'];
  for(const source of sources){
    rmSync(join(config,'settings.json'),{force:true});rmSync(join(config,'plugins'),{recursive:true,force:true});
    rmSync(join(fixture.host,'CLAUDE.md'),{force:true});rmSync(join(claudeDir,'rules'),{recursive:true,force:true});rmSync(join(claudeDir,'skills'),{recursive:true,force:true});
    const plugin=join(control,'plugin');rmSync(plugin,{recursive:true,force:true});
    if(source==='CLAUDE.md')writeFileSync(join(fixture.host,'CLAUDE.md'),marker);
    if(source==='rules'){mkdirSync(join(claudeDir,'rules'));writeFileSync(join(claudeDir,'rules','synthetic.md'),marker);}
    if(source==='skills'){mkdirSync(join(claudeDir,'skills','synthetic'),{recursive:true});writeFileSync(join(claudeDir,'skills','synthetic','SKILL.md'),`---\nname: synthetic\ndescription: ${marker}\n---\nSynthetic control.`);}
    if(source==='plugin-agent'||source==='installed-plugin'||source==='plugin-url'){mkdirSync(join(plugin,'.claude-plugin'),{recursive:true});mkdirSync(join(plugin,'agents'));writeFileSync(join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'synthetic-loader',version:'1.0.0'}));writeFileSync(join(plugin,'agents','synthetic.md'),`---\nname: synthetic\ndescription: ${marker}\n---\nSynthetic control.`);}
    if(source==='plugin-url'){const zip=join(control,'plugin.zip');rmSync(zip,{force:true});execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',plugin,zip],{timeout:5000});pluginArchive=readFileSync(zip);}
    const added=join(control,'added');rmSync(added,{recursive:true,force:true});if(source==='add-dir'){mkdirSync(added);writeFileSync(join(added,'CLAUDE.md'),marker);}
    if(source==='installed-plugin'){mkdirSync(join(config,'plugins'),{recursive:true});writeFileSync(join(config,'plugins','installed_plugins.json'),JSON.stringify({version:2,plugins:{'synthetic-loader@synthetic':[{scope:'user',installPath:plugin,version:'1.0.0',installedAt:'2026-01-01T00:00:00.000Z',lastUpdated:'2026-01-01T00:00:00.000Z'}]}}));writeFileSync(join(config,'settings.json'),JSON.stringify({enabledPlugins:{'synthetic-loader@synthetic':true}}));}
    for(const mode of source==='invalid-agent'?['restricted']:['positive','restricted']){
      row={source,mode,requests:[],nativeAttempt:false,nativeError:false};facts.cases.push(row);
      const mcp=source==='invalid-agent'?JSON.stringify({mcpServers:{origin:{command:process.execPath,args:[join(import.meta.dirname,'prototype-claude-fixture-bridge.mjs'),`${env.ANTHROPIC_BASE_URL}/bridge`]}}}):'{"mcpServers":{}}';
      const flags=['-p','--output-format','stream-json','--verbose','--model','group/auto-mimo-v2-6-flash[1m]','--effort','high','--strict-mcp-config','--mcp-config',mcp,'--permission-mode','dontAsk','--permission-prompts','none','--setting-sources',mode==='restricted'?'':'user,project,local',...(mode==='restricted'?['--bare','--tools','','--disallowedTools','Bash,Read,Write,Edit,Glob,Grep,Agent,Task,Skill,ToolSearch,WebFetch,WebSearch','--disable-slash-commands','--no-chrome','--allowedTools','mcp__origin__remote_read,mcp__origin__remote_write,mcp__origin__remote_command']:[]),...(source==='plugin-agent'?['--plugin-dir',plugin]:[]),...(source==='plugin-url'?['--plugin-url',`${env.ANTHROPIC_BASE_URL}/plugin.zip`]:[]),...(source==='add-dir'?['--add-dir',added]:[]),...(source==='agents'?['--agents',JSON.stringify({synthetic:{description:marker,prompt:'Synthetic loader control.'}})]:[]),'--','Reply READY.'];
      child=spawn('/usr/bin/sandbox-exec',['-p',profile,cli,...flags],{cwd:fixture.host,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>child.kill('SIGKILL'),14000);const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer);child=null;
      row.exitCode=code;row.diagnosticLabels=['Unknown','invalid','plugin','marketplace','permission','ENOENT','EPERM','error'].filter(x=>(stderr+' '+stdout).toLowerCase().includes(x.toLowerCase()));row.timedOut=code===null;row.nativeAttempt=stdout.includes('synthetic_agent_attempt');row.nativeError=/No such tool|Unknown tool|Tool.*not.*found/.test(stdout+stderr);row.sentinelUnchanged=readFileSync(sentinel,'utf8')==='HOST_SENTINEL_UNCHANGED';row.contextObserved=row.requests.some(r=>r.contextMarker);row.requestCount=row.requests.length;
    }
  }
  facts.loaderPairs=sources.filter(source=>source!=='invalid-agent').map(source=>{const positive=facts.cases.find(r=>r.source===source&&r.mode==='positive');const restricted=facts.cases.find(r=>r.source===source&&r.mode==='restricted');return {source,positiveChannelEstablished:positive?.contextObserved===true&&positive.exitCode===0,restrictedRequestObserved:restricted?.requestCount>0&&restricted.exitCode===0,restrictedContextAbsent:restricted?.contextObserved===false,sentinelUnchanged:positive?.sentinelUnchanged===true&&restricted?.sentinelUnchanged===true,disposition:positive?.contextObserved===true&&restricted?.requestCount>0&&restricted.contextObserved===false?'positive control and restricted context exclusion observed; explicit sources additionally require launch capture':'unproved: positive native source channel not established'};});
} catch(error){facts.blocker=error.message==='pin-drift'?'pin-drift':'native-observation-failure';}
finally{clearTimeout(deadline);child?.kill('SIGKILL');if(server)await new Promise(r=>server.close(r));fixture.cleanup();writeFileSync('docs/research/oar-claude-rework2-loader-evidence.json',JSON.stringify(facts,null,2)+'\n');console.log(JSON.stringify(facts));}
