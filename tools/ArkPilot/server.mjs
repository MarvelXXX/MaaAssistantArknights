import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { listDevices, connectDevice, selectDevice } from './lib/device.mjs';
import { isPracticeFormation, recognize } from './lib/vision.mjs';
import { chooseModel, listModels, explainFrames, proposeTeam } from './lib/model.mjs';
import { requestsPracticeOnly, runAgent } from './lib/agent.mjs';
import { chapterRewards, stageRewards } from './lib/rewards.mjs';
import { briefPlan, checkPlan, importGuide, matchesRewardStage, openBiliMedia, paradoxStageId, roguelikePlacements, searchGuides } from './lib/guides.mjs';
import { executeMaa, maaHome, nativeAction, pausedBattleFrame, recognizeRecording, scanRoster, watchBattlePause, watchDaemonSelection, watchTutorialDialog } from './lib/maa.mjs';
import { adaptGuide, normalizeRoster, rosterFit } from './lib/roster.mjs';
import { analyzeVideo, readWiki, searchWeb } from './lib/research.mjs';
import { runRewardQueue } from './lib/reward-queue.mjs';
import { nativeCommand } from './public/native-commands.js';
import { defaultCodexModel, selectedProvider } from './public/model-settings.js';

const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
staticFiles.set('/native-commands.js', ['native-commands.js', 'text/javascript']);
staticFiles.set('/model-settings.js', ['model-settings.js', 'text/javascript']);
staticFiles.set('/guides.js', ['guides.js', 'text/javascript']);
function eventStream(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  res.flushHeaders();
  return event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
}
function backgroundQueue(serial) {
  const info = {id:randomUUID(),serial};
  const controller = new AbortController();
  const clients = new Set();
  let checkpoint, frame;
  return {
    info, controller,
    subscribe(res) {
      const send = eventStream(res);
      clients.add(res);
      res.once('close',()=>clients.delete(res));
      send({type:'queue',...info});
      if (checkpoint) send(checkpoint);
      if (frame) send(frame);
    },
    emit(event) {
      if (event.type==='checkpoint') checkpoint=event;
      if (event.type==='frame') frame=event;
      if (!clients.size) return;
      const line=JSON.stringify(event)+'\n';
      for (const res of clients) {
        // A stalled viewer can reconnect to the latest frame without holding up the emulator.
        if (res.writableLength>2*1024*1024) res.destroy();
        else if (!res.destroyed) res.write(line);
      }
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function devicePreview(device, signal) {
  const { preview, width, height, client, anchors, recognition } = await recognize(await device.capture(signal), signal);
  return { preview, width, height, client, anchors, recognition };
}
async function body(req, maxBytes = 524288) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new Error('请求需要 JSON 对象。');
}
function modelConfig(data) {
  if (data.provider!=null && !['api','codex'].includes(data.provider)) throw new Error('未知的模型连接方式。');
  if (selectedProvider(data)==='codex') {
    const model=data.provider==='codex' ? data.model ?? '' : defaultCodexModel;
    if (typeof model!=='string' || model.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(model.trim())) throw new Error('Codex 模型 ID 无效。');
    return {provider:'codex',model:model.trim(),vision:data.vision!==false};
  }
  for (const [key, max] of [['url', 2000], ['key', 4000], ['model', 250]]) {
    if (data[key] != null && (typeof data[key] !== 'string' || data[key].length > max)) throw new Error('模型配置格式有误。');
  }
  if (!data.url?.trim()) throw new Error('请先在连接设置中填写模型服务 URL。');
  return {provider:'api',apiOptIn:true,url:data.url.trim(),key:data.key?.trim(),model:data.model?.trim(),vision:data.vision!==false};
}
function historyFrom(data) {
  if (!Array.isArray(data)) return [];
  return data.slice(-12).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')
    .map(m => ({ role: m.role, text: m.text.slice(0, 4000) }));
}

export function createServer({ getDevice = selectDevice, getHome = maaHome, native = executeMaa, recording = recognizeRecording, runQueue = runRewardQueue } = {}) {
  let active = false;
  let background;
  return http.createServer(async (req, res) => {
    // Browser requests must originate in this local UI, including after DNS rebinding.
    const port = req.socket.localPort;
    const host = req.headers.host;
    if (![ '127.0.0.1:' + port, 'localhost:' + port ].includes(host) ||
        (req.headers.origin && req.headers.origin !== 'http://' + host) ||
        req.headers['sec-fetch-site'] === 'cross-site' && req.url?.startsWith('/api/')) return json(res, 403, { error: '仅接受本机界面请求。' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    let signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    try {
      if (req.method === 'GET' && staticFiles.has(req.url)) {
        const [name, type] = staticFiles.get(req.url);
        const file = await readFile(new URL('./public/' + name, import.meta.url));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return res.end(file);
      }
      if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { app: 'ArkPilot', guides:true, strategy:true, active, queue:background?.info });
      const media = req.method === 'GET' && req.url.match(/^\/api\/guides\/media\/(BV[a-zA-Z0-9]{10})\/(\d{1,4})$/);
      if (media) {
        const src = await openBiliMedia(media[1], Number(media[2]), signal, req.headers.range);
        const headers = {'Content-Type':'video/mp4'};
        for (const key of ['content-length','content-range','accept-ranges']) {
          if (src.headers.has(key)) headers[key] = src.headers.get(key);
        }
        res.writeHead(src.status,headers);
        await pipeline(Readable.fromWeb(src.body),res,{signal});
        return;
      }
      if (req.method === 'POST' && req.url === '/api/guides/video' && req.headers['content-type'] === 'application/octet-stream') {
        if (active) return json(res,409,{error:'有任务正在运行。'});
        if (Number(req.headers['content-length']) > 1024 ** 3) return json(res,413,{error:'录像超过 1 GiB。'});
        active = true;
        try {
          const emit = eventStream(res);
          const result = await recording(req, req.headers['x-video-ext'], await getHome(), signal,
            text => emit({type:'core',text}));
          emit({type:'guide', ...result}); return res.end();
        } finally { active = false; }
      }
      if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
        return json(res, 404, { error: '未知请求。' });
      }
      const data = await body(req, req.url === '/api/guides/frames' ? 6 * 1024 * 1024 : undefined);
      switch (req.url) {
        case '/api/reward-queue/attach':
        case '/api/reward-queue/stop': {
          if (!background || data.id!==background.info.id) return json(res,409,{error:'该后台清单已结束。'});
          if (req.url.endsWith('/attach')) return background.subscribe(res);
          background.controller.abort();
          return json(res,200,{stopping:true});
        }
        case '/api/roster/maa-file': {
          const home = await getHome();
          const input = home && await readFile(path.join(home,'data','OperBoxData.json'),'utf8').catch(()=>null);
          if (!input) throw new Error('未找到 Maa 保存的名册，可从文件导入或用 Maa 扫描。');
          const raw = JSON.parse(input.replace(/^\uFEFF/,''));
          return json(res,200,{...await normalizeRoster(raw),syncTime:typeof raw.syncTime === 'string' ? raw.syncTime.slice(0,50) : null});
        }
        case '/api/roster/import': return json(res,200,await normalizeRoster(data));
        case '/api/roster/scan': {
          if (active) return json(res,409,{error:'有任务正在运行。'});
          if (data.readOnly !== false) throw new Error('Maa 扫描会翻动游戏干员列表，请切换到允许操作。');
          active = true;
          try {
            const device = await getDevice(data.serial,signal);
            return json(res,200,await normalizeRoster(await scanRoster({device,serial:data.serial,home:await getHome(),signal})));
          } finally { active = false; }
        }
        case '/api/guides/adapt': {
          const config = modelConfig(data);
          return json(res,200,await adaptGuide(checkPlan(data.guide),await normalizeRoster(data.roster),
            String(data.notes || '').slice(0,6000),m=>proposeTeam(config,m,signal)));
        }
        case '/api/guides/online-video': {
          if (active) return json(res,409,{error:'有任务正在运行。'});
          active = true;
          try {
            const home = await getHome();
            if (!home) throw new Error('录像转作业需要 Maa 运行包。');
            const src = await openBiliMedia(data.bv,data.part,signal);
            const emit = eventStream(res);
            const result = await recording(Readable.fromWeb(src.body),'mp4',home,signal,text => emit({type:'core',text}));
            emit({type:'guide',...result}); return res.end();
          } finally { active = false; }
        }
        case '/api/maa': return json(res,200,{home:await getHome()});
        case '/api/guides/search': {
          const roster = data.roster && await normalizeRoster(data.roster);
          return json(res,200,{results:await searchGuides(data.query,signal,data.videoCode,false,roster && (plan=>rosterFit(plan,roster)))});
        }
        case '/api/guides/import': return json(res,200,await importGuide(data.value,signal));
        case '/api/guides/frames': return json(res,200,await explainFrames(modelConfig(data),data.frames,signal));
        case '/api/guides/check': {
          if (active) return json(res,409,{error:'有任务正在运行。'});
          active = true;
          try {
            const version = await native({task:'Copilot'}, {home:await getHome(), guide:checkPlan(data.guide), prepare:true, signal});
            return json(res,200,{version});
          } finally { active = false; }
        }
        case '/api/devices': return json(res, 200, { devices: await listDevices(signal) });
        case '/api/connect': return json(res, 200, { devices: await connectDevice(data.address, signal) });
        case '/api/models': return json(res, 200, { models: await listModels(modelConfig(data), signal) });
        case '/api/preview': {
          const device = await getDevice(data.serial, signal);
          return json(res, 200, await devicePreview(device, signal));
        }
        case '/api/run': break;
        default: return json(res, 404, { error: '未知接口。' });
      }
      const attachedGuide = data.guide == null ? null : checkPlan(data.guide);
      const roster = data.roster ? await normalizeRoster(data.roster) : null;
      const researchOnly = data.researchOnly === true;
      const instruction = data.instruction?.trim();
      const nativeRequest = data.native ?? nativeCommand(instruction);
      const direct = nativeRequest ? nativeAction(nativeRequest,!!attachedGuide) : null;
      if (direct && (data.readOnly === true || researchOnly)) throw new Error('当前为只读分析，请切换到允许操作再运行 Maa。');
      const config = direct ? null : modelConfig(data);
      if (!instruction || instruction.length > 4000) throw new Error('指令长度应在 1 至 4000 字之间。');
      const detached = instruction === '/后台首通清单';
      if (detached && data.backgroundQueue!==true) throw new Error('请刷新指令台以使用后台运行和停止功能。');
      const queue = detached || instruction === '/首通清单';
      const queueFile = queue && (process.env.ARK_REWARD_QUEUE ||
        parseEnv(await readFile(new URL('./.env',import.meta.url),'utf8').catch(()=> '')).ARK_REWARD_QUEUE);
      if (queue && (direct || researchOnly || data.readOnly || !config?.vision || !queueFile)) {
        throw new Error('首通清单需要已配置的本地清单、视觉模型和允许操作模式。');
      }
      const limit = data.limit ?? 24;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('步数上限应为 1 至 100。');
      if (active) return json(res, 409, { error: '已有指令在执行，请在原对话中停止或等待结束。' });
      active = true;
      const job = detached ? backgroundQueue(data.serial) : null;
      try {
        if (job) {
          background=job;
          job.subscribe(res);
        }
        const setupSignal = job ? AbortSignal.any([job.controller.signal,AbortSignal.timeout(30*60*1000)]) : signal;
        const device = researchOnly ? null : await getDevice(data.serial, setupSignal);
        const home = await getHome();
        if (config) config.model = await chooseModel(config, setupSignal);
        const emit = job ? job.emit : eventStream(res);
        async function runCommand({instruction, signal, emit, history = [], guide = null, guideId, onGuideStart, resumeAfterStep, limit, expectedStage, intelExchange, inspectBase, allowNative = true, fixedTeam = false}) {
          let adaptationBlocked = false;
          let formation = !fixedTeam && data.formation === true;
          // First-clear instructions may describe earlier rehearsals as evidence.
          const practiceOnly = !queue && requestsPracticeOnly(instruction);
          const runNative = async (a, afterStep) => {
            if (practiceOnly && ['Fight','Copilot','ParadoxCopilot'].includes(a.task) &&
                (a.task!=='Copilot' || !isPracticeFormation(await devicePreview(device,signal)))) {
              throw Object.assign(new Error('本次只演习。请从关卡详情点演习，停在有蓝色 PLAN 按钮的编队页再调用 Copilot。'),{beforeStart:true});
            }
            if (expectedStage && (!['Copilot','ParadoxCopilot'].includes(a.task) || !await matchesRewardStage(guide,expectedStage))) {
              throw Object.assign(new Error('当前作业不是本项首通目标，请用准确的关卡 ID 重新载入。'),{beforeStart:true});
            }
            const paradox = (a.task === 'Copilot' || a.task === 'ParadoxCopilot') && await paradoxStageId(guide);
            if (a.task === 'ParadoxCopilot' && !paradox) throw Object.assign(new Error('请先导入目标悖论模拟的作业。'),{beforeStart:true});
            let supportSlot;
            if (a.task === 'Copilot' && !paradox && !fixedTeam) {
              const fit = roster && rosterFit(guide,roster);
              if (queue && expectedStage && formation) supportSlot = fit?.supportSlot;
              if (adaptationBlocked || (fit?.unconfirmedSlots.length && !supportSlot)) {
                throw Object.assign(new Error('当前名册与作业尚未匹配，请先适配阵容或选择其他作业。'),{beforeStart:true});
              }
              if (supportSlot) emit({type:'core',text:'Maa 将核对编队位置 '+supportSlot+'，缺少时尝试使用助战干员。'});
            }
            const observer = new AbortController();
            const watching = AbortSignal.any([signal,observer.signal]);
            const stalled = fixedTeam ? watchTutorialDialog() : null;
            const watchPause = afterStep ? watchBattlePause() : null;
            const selectedPanel = watchDaemonSelection(guide);
            let phase = '';
            let timer;
            const updateFrame = async () => {
              try {
                const frame = await devicePreview(device, watching);
                if (!watching.aborted) {
                  emit({type:'frame',...frame});
                  const pause = watchPause?.(frame,Date.now());
                  if (pause==='resume') {
                    const fresh = await devicePreview(device,watching);
                    if (pausedBattleFrame(fresh)) {
                      await device.input({type:'tap',x:Math.round(fresh.width*0.958),y:Math.round(fresh.height*0.075)},watching);
                      emit({type:'core',text:'检测到战斗持续暂停，已点击继续，等待作业执行。'});
                    }
                  } else if (pause==='stalled') {
                    observer.abort(new Error('战斗持续暂停。请核实右上角继续按钮并从同一局接手。'));
                  } else if (selectedPanel(phase,frame,Date.now())) {
                    observer.abort(new Error('Maa 已摆完，干员详情持续敞开，游戏处于慢速。接管同一局，先点地图空白处收起面板，避开撤退与技能按钮，再观察敌人和结算。不要重开。'));
                  } else if (stalled?.(phase,frame.anchors,Date.now())) {
                    observer.abort(new Error('教学停在同一击杀数和指引对白。当前战斗仍在进行；按高亮卡片与箭头用 deploy 完成指引，不要等待费用增长或重开。'));
                  }
                }
              } catch {
                // The native task monitors its own connection. Retry a missed preview on the next tick.
              }
              if (!watching.aborted) timer = setTimeout(updateFrame, 5000);
            };
            timer = setTimeout(updateFrame, 1500);
            try {
              if (guideId) onGuideStart?.(guideId);
              const selected = new Set();
              await native(a, {home,device,serial:data.serial,guide,formation,practiceOnly,borrowSupport:!!supportSlot,afterStep,signal:watching,progress:(text,evidence)=>{
                if (evidence?.selectedOperator) selected.add(evidence.selectedOperator);
                phase = text;
                emit({type:'core',text});
              }});
              if (selected.size) return 'Maa 自动编队已选入' + [...selected].join('、') + '。请结合画面核对实际部署和结算。';
            } finally {
              observer.abort();
              clearTimeout(timer);
            }
          };
          if (direct) {
            emit({type:'decision',action:direct,goal:instruction,note:'正在运行 Maa 任务'});
            const nativeReport = await runNative(direct);
            emit({type:'applied',action:direct});
            const note = direct.task === 'ActivityOrundum' ? 'Maa 已检查幸运墙和限时开采。实际领取数量请核对奖励画面与首页余额。' :
              nativeReport || 'Maa 已报告 ' + direct.task + ' 任务链执行结束。';
            emit({type:'end',outcome:'finish',goal:instruction,note});
            return;
          }
          emit({ type: 'model', model: config.model });
          const guidance = {get formation() { return formation; },
            notes:!queue && typeof data.notes === 'string' ? data.notes.slice(0,6000) : '',plan:briefPlan(guide),
            roster:roster && {complete:roster.complete,operators:roster.operators.map(
              ({name,owned,role,elite,level,skill_level,skill_levels,potential,module,module_level})=>
                ({name,owned,role,elite,level,skill_level,skill_levels,potential,module,module_level}))}};
          const candidates = new Set(instruction.match(/\b[1-9]\d{0,9}\b/g) || []);
          if (!queue && Array.isArray(data.recentSearch)) {
            guidance.candidates = data.recentSearch.slice(0,20).filter(r => typeof r?.id === 'string' && /^[1-9]\d{0,9}$/.test(r.id))
              .map(r => ({id:r.id,title:String(r.title || '').slice(0,150)}));
            for (const r of guidance.candidates) candidates.add(r.id);
          }
          const cache = new Map();
          const excerpts = [];
          const videoNotes = [];
          const lookupGuide = async (a,frame) => {
            if (a.type==='roguelike_placements') return roguelikePlacements(a.stage,frame);
            const key = JSON.stringify(a);
            if (cache.has(key)) return cache.get(key);
            if (a.type === 'stage_rewards' || a.type === 'chapter_rewards') {
              const result = await (a.type === 'chapter_rewards' ? chapterRewards : stageRewards)(a.stage, signal);
              emit({type:'sources', results:result.sources});
              cache.set(key, result);
              return result;
            }
            if (a.type === 'search_web') {
              const found = await searchWeb(a.query,a.stage,signal);
              for (const r of found.results) if (r.id) candidates.add(r.id);
              emit({type:'sources',results:found.results}); cache.set(key,found); return found;
            }
            if (a.type === 'read_wiki') {
              const page = await readWiki(a.title,a.section,signal);
              excerpts.push({title:page.title,url:page.url,text:page.excerpt});
              emit({type:'sources',results:[page]}); cache.set(key,page); return page;
            }
            if (a.type === 'analyze_video') {
              const clip = await analyzeVideo(config,a,signal,expectedStage);
              videoNotes.push({guideId,url:clip.url,title:clip.title,notes:clip.notes});
              guidance.notes = (clip.url+'\n'+clip.notes+'\n'+guidance.notes).slice(0,6000);
              emit({type:'video_notes',clip,notes:guidance.notes}); cache.set(key,clip); return clip;
            }
            if (a.type === 'adapt_guide') {
              adaptationBlocked = true;
              if (!roster || !guide) throw new Error('适配需要已导入的作业和当前账号的干员名册。');
              const recentRequests = history.filter(m=>m.role==='user').slice(-3).map(m=>m.text);
              const result = await adaptGuide(guide,roster,guidance.notes,
                m=>proposeTeam(config,{...m,guideId,instruction,recentRequests,wiki:excerpts.slice(-3),videos:videoNotes.slice(-2)},signal));
              if (!result.ready) return {ready:false,reason:result.reason,assessment:result.assessment};
              guide = result.plan; adaptationBlocked = false; formation = !fixedTeam; guidance.plan = briefPlan(guide);
              guidance.notes = (result.reason+'\n'+guidance.notes).slice(0,6000);
              emit({type:'guide_loaded',...result,notes:guidance.notes});
              return {ready:true,reason:result.reason,changes:result.changes,plan:guidance.plan};
            }
            if (a.type === 'find_guide') {
              const found = await searchGuides(a.stage,signal,'',false,roster && (plan=>rosterFit(plan,roster)));
              const results = roster ? found.slice(0,20) : found;
              for (const r of results) candidates.add(r.id);
              emit({type:'guide_search',stage:a.stage,results});
              return results;
            }
            if (!candidates.has(a.id)) throw new Error('请先搜索关卡，或在指令里给出具体作业号。');
            const material = await importGuide(a.id,signal);
            guide = material.plan;
            guideId = a.id;
            adaptationBlocked = false;
            guidance.notes = (material.notes || guide.doc?.details || '').slice(0,6000);
            formation = !fixedTeam && data.formation === true;
            guidance.plan = briefPlan(guide);
            emit({type:'guide_loaded',...material});
            return guidance.plan;
          };
          let continued = false;
          const continueBattle = fixedTeam && resumeAfterStep && allowNative && home ? async step=>{
            if (step!==resumeAfterStep || continued) return;
            continued = true;
            emit({type:'core',text:'已通过教学指引，Maa 从第 '+(step+1)+' 步继续当前战斗。'});
            await runNative({type:'maa',task:'Copilot'},step);
            return 'Maa 已执行后续作业，请核对同一局的结算。';
          } : undefined;
          await runAgent({ config, device, instruction, history, continueBattle, intelExchange, inspectBase, practiceOnly, retryModel:queue, requireAdaptation:queue ? false : undefined,
            readOnly: researchOnly || data.readOnly === true, limit, signal, emit, guidance, lookupGuide, runNative:device && home && allowNative ? runNative : null });
        }
        if (queue) {
          signal = job ? job.controller.signal : controller.signal;
          await runQueue({filename:queueFile, serial:data.serial,
            device, config, runCommand, emit, signal, background:detached});
        } else {
          await runCommand({instruction, signal, emit, history:historyFrom(data.history), guide:attachedGuide, limit});
        }
        if (!job) res.end();
      } catch (error) {
        if (!job) throw error;
        job.emit(job.controller.signal.aborted ? {type:'end',outcome:'stop',goal:'后台首通清单',note:'后台清单已停止，进度已保存。'} :
          {type:'error',text:error.message});
      } finally {
        if (job) { job.close(); background=undefined; }
        active = false;
      }
    } catch (error) {
      if (res.destroyed) return;
      const message = signal.aborted ? '任务已停止或超时。' : error.message;
      if (!res.headersSent) return json(res, 400, { error: message });
      res.end(JSON.stringify({ type: 'error', text: message }) + '\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const local = parseEnv(await readFile(new URL('./.env',import.meta.url),'utf8').catch(()=>''));
  const port = Number(process.env.ARK_PORT || local.ARK_PORT || 17321);
  const url = 'http://127.0.0.1:' + port;
  const open = process.argv.includes('--open') && process.platform === 'win32';
  const browser = () => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log('请在浏览器中打开 ' + url));
    child.unref();
  };
  const server = createServer();
  server.on('error', async error => {
    if (open && error.code === 'EADDRINUSE') {
      try {
        const res = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if ((await res.json()).app === 'ArkPilot') { browser(); return; }
      } catch {}
    }
    console.error('服务启动失败。' + error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('ArkPilot · ' + url);
    if (open) browser();
  });
}
