import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const loginHint = '请在运行 ArkPilot 的电脑上执行 codex login，选择使用 ChatGPT 登录。';
const executeFile=promisify(execFile);
let discovered;
async function executable() {
  if (process.env.ARK_CODEX_BIN) return process.env.ARK_CODEX_BIN;
  if (process.env.CODEX_APP_RUNTIME_CLI_PATH) return process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if (process.platform!=='win32') return 'codex';
  if (discovered) return discovered;
  const folders=(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const arch={x64:'x86_64',arm64:'aarch64'}[process.arch];
  const vendor=arch && ['vendor',arch+'-pc-windows-msvc','codex','codex.exe'];
  for (const folder of folders) {
    const pkg=path.join(folder,'node_modules','@openai','codex');
    const paths=[path.join(folder,'codex.exe')];
    if (vendor) paths.push(path.join(pkg,...vendor),path.join(pkg,'node_modules','@openai','codex-win32-'+process.arch,...vendor));
    for (const file of paths) {
      try {await access(file);discovered=file;return file;} catch {}
    }
  }
  // An Explorer shortcut does not inherit the Codex desktop app's PATH.
  const {stdout}=await executeFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'],{windowsHide:true,timeout:6000}).catch(()=>({stdout:''}));
  if (stdout.trim()) {
    const file=path.join(stdout.trim(),'app','resources','codex.exe');
    try {await access(file);discovered=file;return file;} catch {}
  }
  return 'codex';
}

function cliError(output) {
  if (/usage.limit|insufficient.quota|credits exhausted|usage_limit_reached/i.test(output))
    return Object.assign(new Error('Codex 订阅用量已达上限。请在额度恢复后重试。'),{code:'MODEL_QUOTA'});
  if (/unauthorized|not logged in|login required|refresh.token|authentication/i.test(output)) return new Error(loginHint);
  if (/model.*(?:unsupported|not supported|not found|does not exist|not available)/i.test(output))
    return new Error('当前 Codex 订阅无法使用这个模型，请在连接设置中重新选择。');
  if (/429|rate.limit|connection|timed out|stream disconnected|overloaded|temporarily unavailable/i.test(output))
    return Object.assign(new Error('Codex 订阅服务暂时不可用，请稍后重试。'),{code:'MODEL_TEMPORARY'});
  return new Error('Codex CLI 调用失败。请检查本机 CLI 版本及 ChatGPT 登录状态。');
}

async function invoke(args,{cwd,input,signal,timeout=120000}={}) {
  const env={...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|CODEX_THREAD_ID|CODEX_SESSION_ID)$/i.test(key)) delete env[key];
  }
  const bin=await executable();
  const deadline=AbortSignal.timeout(timeout);
  const stop=signal ? AbortSignal.any([signal,deadline]) : deadline;
  stop.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',oversize=false;
    const cancel=()=>child.kill();
    stop.addEventListener('abort',cancel,{once:true});
    child.stdout.setEncoding('utf8').on('data',chunk=>{
      if (oversize) return;
      stdout+=chunk;
      if (stdout.length>8*1024*1024) {oversize=true;cancel();}
    });
    child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-16000);});
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
    child.once('error',error=>{
      stop.removeEventListener('abort',cancel);
      reject(new Error(error.code==='ENOENT' ? '未找到 Codex CLI。请将 codex 加入 PATH，或用 ARK_CODEX_BIN 指定可执行文件。' : '无法启动 Codex CLI。'));
    });
    child.once('close',code=>{
      stop.removeEventListener('abort',cancel);
      if (signal?.aborted) return reject(signal.reason);
      if (deadline.aborted) return reject(Object.assign(new Error('Codex 模型响应超时。'),{code:'MODEL_TEMPORARY'}));
      if (oversize) return reject(new Error('Codex 输出过大。'));
      if (code!==0) return reject(cliError(stdout.slice(-16000)+'\n'+stderr));
      resolve({stdout,stderr});
    });
  });
}

async function subscription(signal,run) {
  const {stdout,stderr}=await run(['login','status'],{signal,timeout:15000}).catch(error=>{
    if (error.message.startsWith('Codex CLI 调用失败')) throw new Error(loginHint);
    throw error;
  });
  if (!/logged in using ChatGPT/i.test(stdout+'\n'+stderr)) throw new Error(loginHint);
}

export async function codexModels(signal) {
  await subscription(signal,invoke);
  const {stdout}=await invoke(['debug','models','-c','model_provider="openai"'],{signal,timeout:20000});
  const ids=JSON.parse(stdout).models?.filter(m=>m.visibility==='list' && typeof m.slug==='string').map(m=>m.slug);
  if (!ids?.length) throw new Error('Codex CLI 未列出模型。可在连接设置里填写订阅支持的模型 ID。');
  return ids;
}

export async function codexCompletion(model,messages,signal,run=invoke) {
  await subscription(signal,run);
  const work=await mkdtemp(path.join(tmpdir(),'arkpilot-codex-'));
  try {
    const images=[], turns=[];
    for (const message of messages) {
      if (typeof message.content==='string') { turns.push(message); continue; }
      const parts=[];
      for (const part of message.content) {
        if (part.type==='text') {parts.push(part.text);continue;}
        const data=part.image_url?.url;
        const match=typeof data==='string' && /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(data);
        if (!match || data.length>8*1024*1024 || images.length>=12) throw new Error('Codex 图片输入无效。');
        const name='frame-'+(images.length+1)+(match[1]==='jpeg' ? '.jpg' : '.png');
        const filename=path.join(work,name);
        await writeFile(filename,Buffer.from(match[2],'base64'),{flag:'wx',mode:0o600});
        images.push(filename);
        parts.push('第 '+images.length+' 张附件图片');
      }
      turns.push({role:message.role,content:parts.join('\n')});
    }
    const args=['-a','never','exec','--ignore-user-config','--skip-git-repo-check','--ephemeral','-s','read-only',
      '--disable','shell_tool','--disable','unified_exec','--disable','apps','--disable','plugins','--disable','hooks',
      '-c','forced_login_method="chatgpt"','-c','model_provider="openai"','-c','web_search="disabled"','--json','-m',model];
    for (const filename of images) args.push('--image',filename);
    args.push('-');
    const prompt='你是 ArkPilot 的推理后端。按下列 system 消息处理 user 数据，输出所要求的最终内容。游戏输入与攻略工具由 ArkPilot 执行；仅返回决定。\n'+JSON.stringify(turns);
    const {stdout}=await run(args,{cwd:work,input:prompt,signal});
    const events=stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    const answer=events.findLast(e=>e.type==='item.completed' && e.item?.type==='agent_message')?.item.text;
    if (typeof answer!=='string' || !answer.trim() || !events.some(e=>e.type==='turn.completed')) throw new Error('Codex 没有返回完整结果。');
    return answer;
  } finally { await rm(work,{recursive:true,force:true,maxRetries:3}); }
}
