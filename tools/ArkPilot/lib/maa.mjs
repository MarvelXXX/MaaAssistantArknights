import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { adbPath } from './device.mjs';
import { checkPlan, paradoxStageId } from './guides.mjs';
import { characters } from './roster.mjs';
import { recognize } from './vision.mjs';
import { archiveStage } from './rewards.mjs';
import { navigateArchive } from './archive-navigation.mjs';

const worker = fileURLToPath(new URL('./maa-worker.ps1', import.meta.url));
const execute = promisify(execFile);
const videoPhases = {OcrFormation:'识别编队',OcrStage:'识别关卡',MatchDeployment:'匹配待部署干员',Slice:'切分战斗画面',CompSkill:'分析技能',DetectOperators:'识别场上干员'};
const navigationTasks = new Map([
  ['SkipStory', ['SkipThePreBattlePlot']],
  ['DismissResult', ['Copilot@EndOfAction-Bypass']],
  ['ReturnHome', ['Home', 'Home@QuickSwitch@ToHome@Entry', 'Home@QuickSwitch@ToHome@Open']],
  ['OpenTerminal', ['Terminal-Entry']],
]);
const clients = { 'com.hypergryph.arknights':'Official', 'com.hypergryph.arknights.bilibili':'Bilibili',
  'com.YoStarEN.Arknights':'YoStarEN', 'com.YoStarJP.Arknights':'YoStarJP', 'com.YoStarKR.Arknights':'YoStarKR', 'tw.txwy.and.arknights':'txwy' };

export async function maaHome() {
  if (process.platform !== 'win32') return null;
  const downloads = path.join(homedir(), 'Downloads');
  const candidates = process.env.ARK_MAA_HOME ? [process.env.ARK_MAA_HOME] :
    (await readdir(downloads, {withFileTypes:true}).catch(() => []))
      .filter(d => d.isDirectory() && /^MAA(?:$|[-_])/i.test(d.name))
      .sort((a,b) => b.name.localeCompare(a.name, 'en', {numeric:true})).map(d => path.join(downloads,d.name));
  return candidates.find(dir => existsSync(path.join(dir,'MaaCore.dll')) && existsSync(path.join(dir,'resource','config.json'))) || null;
}

export function nativeAction(a, hasPlan) {
  if (a?.task === 'ArchiveStage' && typeof a.stage==='string' && /^[A-Z]{1,4}-(?:TR-)?[1-9]\d?$/i.test(a.stage)) {
    return {type:'maa',task:'ArchiveStage',stage:a.stage.toUpperCase()};
  }
  if (a?.task === 'ParadoxCopilot' && hasPlan && a.skill !== undefined) {
    if (!Number.isInteger(a.skill) || a.skill < 1 || a.skill > 3) throw new Error('悖论技能序号应为 1 至 3。');
    return { type:'maa', task:a.task, skill:a.skill };
  }
  if (['Award','ActivityOrundum'].includes(a?.task) || navigationTasks.has(a?.task)) return { type:'maa', task:a.task };
  if (['Copilot','ParadoxCopilot'].includes(a?.task) && hasPlan) return { type:'maa', task:a.task };
  if (a?.task === 'Fight' && typeof a.stage === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(a.stage) &&
      a.stage.length <= 40 && Number.isInteger(a.times) && a.times >= 1 && a.times <= 100) {
    return { type:'maa', task:'Fight', stage:a.stage.toUpperCase(), times:a.times };
  }
  throw new Error('Maa 任务参数无效：代理刷图需要关卡和 1–100 次，自动战斗需要先导入作业。');
}

// A guided drag pauses the game clock. Kills and DP can both stay fixed until the drag happens.
export function watchTutorialDialog() {
  let lastCount, since;
  return (phase, anchors, now) => {
    const label = anchors.map(a=>a.label.replace(/\s/g,'')).find(s=>/^\d{1,3}[/／]\d{1,3}$/.test(s));
    if (!phase.endsWith('BattleAvatarDialog') || !label) {
      lastCount = undefined;
      return false;
    }
    if (label !== lastCount) {
      lastCount = label;
      since = now;
    }
    return now - since >= 45000;
  };
}

export function pausedBattleFrame({anchors,width,height}) {
  return anchors.some(a=>a.source==='Maa' && a.label==='战斗防御点图标') && anchors.some(a=>{
    if (a.source!=='OCR' || !a.box || !/暂停中|暫停中|PAUSE(?:D)?/i.test(a.label.replace(/\s/g,''))) return false;
    const [x,y,w,h]=a.box;
    return Math.abs((x+w/2)/width-0.5)<0.17 && Math.abs((y+h/2)/height-0.5)<0.12;
  });
}

export function watchBattlePause() {
  let since, sent;
  return (frame,now)=>{
    if (!pausedBattleFrame(frame)) { since=undefined; sent=false; return; }
    since ??= now;
    if (now-since<15000) return;
    if (sent) return 'stalled';
    since=now;
    sent=true;
    return 'resume';
  };
}

export function watchDaemonSelection(guide) {
  const names = new Set([...(guide?.opers || []), ...(guide?.groups || []).flatMap(g=>g.opers)].map(op=>op.name));
  let selected, since, lastSeen;
  return (phase, frame, now) => {
    if (!/^(SkillDaemon|摆完挂机)(?:$| ·)/i.test(phase) ||
        !frame.anchors.some(a=>a.source==='Maa' && a.label==='战斗防御点图标')) {
      selected = undefined;
      return false;
    }
    const panel = frame.anchors.filter(a=>a.source==='OCR' && a.box && a.box[0]+a.box[2]/2 < frame.width*0.35);
    const name = panel.map(a=>a.label.replace(/\s/g,'')).find(s=>names.has(s));
    const stats = panel.map(a=>a.label).join('').replace(/\s/g,'');
    if (!name || ['攻击','防御','阻挡','生命','特性'].filter(s=>stats.includes(s)).length<2) return false;
    // Brief selections are normal while Maa activates skills. Allow one missed OCR sample.
    if (name!==selected || now-lastSeen>14000) { selected=name; since=now; }
    lastSeen=now;
    return now-since>=20000;
  };
}

async function workspace(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'arkpilot-maa-'));
  try { return await fn(dir); }
  finally { await rm(dir, {recursive:true, force:true, maxRetries:3, retryDelay:150}); }
}

export function recognizedDefeat(tag, info) {
  return (tag === '20001' || tag === '20002') &&
    /^(?:[^@]+@)*FightMissionFailed(?:AndStop)?(?:-Bypass)?$/.test(info.details?.task);
}

export async function copilotDefeatReport(work, lastAction, skillAttempts = new Map()) {
  let message = 'Maa 已识别到本局任务失败。';
  let log;
  try {
    log = await open(path.join(work,'debug','asst.log'),'r');
    let last;
    for await (const line of log.readLines()) {
      const sample = line.match(/\] Kills:\s*(\d+)\s*\/\s*(\d+)\s*$/);
      if (sample && Number(sample[2]) > 0 && Number(sample[1]) <= Number(sample[2])) last = sample;
    }
    if (last) message += '原生日志最后识别的击倒数 '+last[1]+'/'+last[2]+'。';
  } catch {
    // The defeat callback remains sufficient when trace logging is disabled or rotated.
  } finally {
    await log?.close().catch(()=>{});
  }
  if (lastAction) message += '失败前最后尝试的作业动作 '+lastAction+'。';
  if (skillAttempts.size) {
    const counts = Array.from(skillAttempts, ([name,count]) => name+' ×'+count);
    message += '作业手动技能步骤回调：'+counts.join('、')+'。这些回调在等待触发条件前发出，技能生效需由战斗画面核实。';
  }
  return message;
}

// Receives only internally constructed task types and parameters. The child owns
// MaaCore and its callbacks; disconnecting the request also stops this worker.
export async function runCore({ home, work, client = '', serial = '', type, params, stageTask, prepare = false, onBox }, signal, progress = () => {}) {
  signal.throwIfAborted();
  if (!home) throw new Error('未找到 Maa 运行包。请设置 ARK_MAA_HOME 指向包含 MaaCore.dll 和 resource 的安装目录，再启动 ArkPilot。');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',worker],
      {cwd:home, windowsHide:true, stdio:['pipe','pipe','pipe']});
    let forceTimer, stderr = '', last = '', coreVersion = '', videoPhase = '';
    const copilot = ['Copilot','ParadoxCopilot','SingleStep'].includes(type);
    let defeat = false, lastAction = '';
    const skillAttempts = new Map();
    const abort = () => {
      child.stdin.end('stop\n');
      forceTimer = setTimeout(() => child.kill(), 2500);
    };
    signal.addEventListener('abort', abort, {once:true});
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1000); });
    const lines = createInterface({input:child.stdout});
    lines.on('line', line => {
      const split = line.indexOf('\t');
      if (split < 0) return;
      const tag = line.slice(0,split), content = line.slice(split+1);
      if (tag === 'version') { coreVersion = content; progress('MaaCore ' + content); return; }
      let info;
      try { info = JSON.parse(content); } catch { return; }
      if (info.what === 'ScreencapCost' || info.what === 'EmulatorFPS') return;
      if (type === 'OperBox' && info.what === 'OperBoxInfo' && info.details?.done === true) onBox?.(info.details.own_opers);
      let name = String(info.why || info.what || info.details?.task || info.subtask || info.taskchain || '').slice(0,120);
      if (type === 'VideoRecognition' && Object.hasOwn(videoPhases,info.what)) {
        videoPhase = videoPhases[info.what]; name = videoPhase;
      }
      if (info.what === 'CopilotAction') {
        name = [info.details?.action,info.details?.target].filter(Boolean).join(' · ').slice(0,120);
        if (!defeat) lastAction = name;
        if (!defeat && info.details?.action === 'UseSkill') {
          const target = String(info.details.target || '未命名目标').slice(0,60);
          skillAttempts.set(target,(skillAttempts.get(target) || 0)+1);
        }
      }
      if (copilot && recognizedDefeat(tag,info)) defeat = true;
      if (info.what === 'StageDrops' && Number.isInteger(info.details?.stars)) name = '关卡结算 · ' + info.details.stars + ' 星';
      if ([2,10001,20000,20001,20003].includes(Number(tag)) && name && name !== last) { last = name; progress(name); }
    });
    child.once('error', err => { reject(new Error('无法启动 Maa 工作进程。' + err.message)); });
    child.once('close', async code => {
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(signal.reason);
      if (defeat) return reject(new Error(await copilotDefeatReport(work,lastAction,skillAttempts)));
      if (code !== 0) {
        if (type === 'VideoRecognition' && videoPhase) return reject(new Error('视频已解码，Maa 未能完成' + videoPhase + '。'));
        const err = new Error('Maa 未完成 ' + type + '。' + (stderr.trim() || '请检查运行包依赖、设备连接或素材。') + (last ? ' 最近事件：' + last : ''));
        err.decoderFailed = type === 'VideoRecognition' && /VideoCapture|VIDEOIO|video_io/.test(stderr);
        return reject(err);
      }
      resolve(coreVersion);
    });
    child.stdin.write(JSON.stringify({home, work, client, adb:adbPath(), serial, type, params:JSON.stringify(params),
      stageTask:stageTask && JSON.stringify(stageTask), prepare}) + '\n');
  });
}

async function connectedCore(job, device, signal, progress) {
  const client = clients[await device.checkGame(signal)];
  if (!client) throw new Error('请先将明日方舟切到前台。');
  const guard = new AbortController();
  const combined = AbortSignal.any([signal,guard.signal]);
  let timer;
  const verify = async () => {
    try {
      await device.checkGame(combined);
      if (!combined.aborted) timer = setTimeout(verify,1000);
    } catch (error) { guard.abort(error); }
  };
  timer = setTimeout(verify,1000);
  try { return await runCore({...job,client},combined,progress); }
  finally { clearTimeout(timer); guard.abort(); }
}

export async function scanRoster({home, device, serial, signal}) {
  return workspace(async work => {
    let rows;
    await connectedCore({home,work,serial,type:'OperBox',params:{},onBox:value => { rows = value; }},device,signal);
    if (!Array.isArray(rows) || !rows.length) throw new Error('未读到干员，请先打开无筛选的干员列表再扫描。');
    return {own_opers:rows};
  });
}

export async function paradoxNavigationPlan(plan, stage, selectedSkill) {
  const details = plan.doc?.details || '';
  if (plan.opers?.length || plan.groups?.length) {
    if (selectedSkill !== undefined) throw Object.assign(new Error('作业已有编队技能。请直接执行附件或先核对冲突。'),{beforeStart:true});
    return plan;
  }
  const instructions = details.split(/(?:^|[，,。；;：:\n])\s*(?:请\s*)?(?:手选|手动选择?)/).slice(1);
  if (!instructions.length && selectedSkill === undefined) return plan;

  // List navigation defaults to skill one when the published plan omits its operator.
  const skills = new Set(selectedSkill === undefined ? [] : [selectedSkill]);
  const manualSelection = () => Object.assign(new Error('该悖论作业需要手选技能。请在游戏内核对并选好技能，再从本关准备界面执行 Copilot。'),{beforeStart:true});
  for (const part of instructions) {
    const slot = part.match(/^\s*(?:第\s*)?([123一二三])\s*技能(?=\s*(?:进入|进图|开战|开始|[，,。；;！!\n]|$))/)?.[1];
    if (!slot) throw manualSelection();
    skills.add(Number(slot) || '一二三'.indexOf(slot)+1);
  }
  const id = /^mem_(.+)_\d+$/.exec(stage)?.[1];
  const matches = id ? (await characters()).characters.filter(op=>op.id.endsWith('_'+id)) : [];
  if (skills.size!==1 || matches.length!==1) throw manualSelection();
  const [skill] = skills, [owner] = matches;
  const maxSkill = owner.rarity >= 6 ? 3 : owner.rarity >= 4 ? 2 : owner.rarity === 3 ? 1 : 0;
  if (!Number.isInteger(skill) || skill < 1 || skill > maxSkill) throw manualSelection();
  return {...plan,opers:[{name:owner.name,skill}]};
}

export async function executeMaa(action, { home, device, serial, guide, formation, borrowSupport, signal, progress, prepare = false, afterStep }) {
  const a = nativeAction(action, !!guide);
  return workspace(async work => {
    let params, stageTask;
    let type = a.task;
    if (type === 'ArchiveStage') {
      const target = await archiveStage(a.stage,signal);
      const tasks = path.join(work,'overlay','resource','tasks');
      await mkdir(tasks,{recursive:true});
      await writeFile(path.join(tasks,'arkpilot.json'),JSON.stringify({
        ArkPilotArchiveMapNode:{baseTask:'SideStoryStage',text:[target.code],fullMatch:true,next:[]},
        ArkPilotArchiveStageCode:{baseTask:'SideStoryStage',text:[target.code],roi:[670,35,590,360],fullMatch:true,action:'DoNothing',next:[]},
      }));
      const step = task => connectedCore({home,work,serial,type:'Custom',params:{task_names:[task]}},device,signal,progress);
      return navigateArchive(target,device,signal,step,progress);
    }
    if (a.task === 'Fight') params = {stage:a.stage, times:a.times, medicine:0, stone:0, expiring_medicine:0, medicine_expire_days:0};
    if (navigationTasks.has(a.task)) {
      type = 'Custom';
      if (a.task === 'OpenTerminal' && !prepare) {
        const frame = await recognize(await device.capture(signal),signal);
        if (!frame.anchors.some(anchor=>anchor.source==='Maa' && anchor.label==='主界面设置入口')) {
          throw new Error('请先返回游戏首页再打开作战终端。');
        }
      }
      params = {task_names:navigationTasks.get(a.task)};
    }
    if (a.task === 'Award' || a.task === 'ActivityOrundum') {
      type = 'Award';
      const activity = a.task === 'ActivityOrundum';
      params = {award:!activity, mail:false, recruit:false, orundum:activity, mining:activity, specialaccess:false, signinevent:false};
    }
    if (a.task === 'Copilot' || a.task === 'ParadoxCopilot') {
      const filename = path.join(work, 'plan.json');
      const original = checkPlan(guide);
      const stage = await paradoxStageId(original);
      if (a.task === 'ParadoxCopilot' && !stage) throw new Error('从干员列表启动悖论模拟需要对应的悖论作业。');
      const plan = a.task==='ParadoxCopilot' ? await paradoxNavigationPlan(original,stage,a.skill) : original;
      await writeFile(filename, JSON.stringify(stage ? {...plan,stage_name:stage} : plan), 'utf8');
      if (afterStep != null) {
        if (a.task!=='Copilot' || !Number.isInteger(afterStep) || afterStep<1 || afterStep>=plan.actions.length) {
          throw new Error('续打起点与作业不匹配。');
        }
        const actions = plan.actions.slice(afterStep);
        const allowed = ['Deploy','Skill','Retreat','SpeedUp','SkillDaemon','SkillUsage','Output','部署','技能','撤退','二倍速','摆完挂机'];
        if (actions.some(step=>!allowed.includes(step.type || 'Deploy'))) throw new Error('续打仅接受部署、技能和其他战斗内作业步骤。');
        type = 'SingleStep';
        stageTask = {type:'copilot',subtype:'stage',details:{stage_name:stage || plan.stage_name}};
        params = {type:'copilot',subtype:'action',details:{actions}};
      } else if (stage) {
        type = 'ParadoxCopilot';
        // Maa accepts a list when it must find the operator and select the skill.
        params = a.task === 'ParadoxCopilot' ? {list:[filename]} : {filename};
      } else {
        params = {filename, formation:formation === true, loop_times:1, use_sanity_potion:false};
        if (params.formation && borrowSupport === true) params.support_unit_usage = 1;
      }
    }
    const job = {home, work, type, params, stageTask, serial, prepare};
    if (prepare) return runCore(job, signal, progress);
    if (a.task === 'ParadoxCopilot') {
      const frame = await recognize(await device.capture(signal),signal);
      if (frame.anchors.some(anchor=>anchor.source==='Maa' && anchor.label==='主界面设置入口')) {
        progress?.('从首页进入干员列表');
        await connectedCore({home,work,serial,type:'Custom',params:{task_names:['OperBoxBegin']}},device,signal,progress);
      }
    }
    return connectedCore(job,device,signal,progress);
  });
}

export async function ffmpegPath() {
  const local = await readFile(new URL('../.env',import.meta.url),'utf8').catch(() => '');
  return process.env.ARK_FFMPEG || parseEnv(local).ARK_FFMPEG || 'ffmpeg';
}
async function convertToMjpeg(filename, output, ext, signal) {
  const ffmpeg = await ffmpegPath();
  const demuxer = {mp4:'mov',mov:'mov',avi:'avi',mkv:'matroska',webm:'matroska'}[ext];
  try {
    await execute(ffmpeg,['-nostdin','-v','error','-protocol_whitelist','file,pipe','-f',demuxer,'-i',filename,'-map','0:v:0',
      '-an','-sn','-dn','-vf','fps=12,scale=-2:min(720\\,ih)','-threads','2','-c:v','mjpeg','-q:v','4','-fs','1073741824',output],
    {signal,windowsHide:true,timeout:300000,maxBuffer:256000});
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(error.code === 'ENOENT' ? '当前 Maa 无法直接解码，并且未找到 FFmpeg。可用 ARK_FFMPEG 指定解码器，或使用片段解读。' : 'FFmpeg 无法完整转换这段录像，可使用片段解读。');
  }
  if ((await stat(output)).size >= 1024**3 - 65536) throw new Error('转换后的录像过大，请截取单场战斗。');
}

export async function recognizeRecording(stream, ext, home, signal, progress = () => {}) {
  if (!home) throw new Error('本地录像转作业需要 Maa 运行包。');
  if (!['mp4','mkv','avi','mov','webm'].includes(ext)) throw new Error('请选择 MP4、MKV、AVI、MOV 或 WebM 战斗录像。');
  return workspace(async work => {
    const filename = path.join(work, 'battle.' + ext);
    let bytes = 0;
    const limit = new Transform({transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > 1024 ** 3) return done(new Error('录像超过 1 GiB，请剪出单次战斗。'));
      done(null, chunk);
    }});
    await pipeline(stream, limit, createWriteStream(filename, {flags:'wx'}), {signal});
    if (!bytes) throw new Error('录像文件为空。');
    const recognize = file => runCore({home, work, type:'VideoRecognition', params:{filename:file}},signal,progress);
    try { await recognize(filename); }
    catch (error) {
      signal.throwIfAborted();
      if (!error.decoderFailed) throw new Error(error.message + ' 可改用片段解读，或查找引用此 BV 的作业。');
      progress('正在转换为 Maa 可读取的 MJPEG 录像');
      const avi = path.join(work,'decoded.avi');
      await convertToMjpeg(filename,avi,ext,signal);
      try { await recognize(avi); }
      catch (retry) { signal.throwIfAborted(); throw new Error(retry.message + ' 可改用片段解读，或查找引用此 BV 的作业。'); }
    }
    const output = path.join(work, 'cache', 'CombatRecord');
    const files = await readdir(output).catch(() => []);
    const result = files.find(f => f.endsWith('.json'));
    if (!result) throw new Error('Maa 未生成战斗作业。请使用含编队画面、关卡名和完整战斗的原始录像，或用视觉模型解读片段。');
    const plan = checkPlan(JSON.parse(await readFile(path.join(output,result),'utf8')));
    if (plan.doc?.details) plan.doc.details = plan.doc.details.replaceAll(work,'临时录像');
    return {plan, source:'Maa 录像识别草稿'};
  });
}
