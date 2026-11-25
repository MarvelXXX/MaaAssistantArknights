import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { listDevices, connectDevice, selectDevice } from './lib/device.mjs';
import { recognize } from './lib/vision.mjs';
import { chooseModel, listModels, explainFrames, proposeTeam } from './lib/model.mjs';
import { runAgent } from './lib/agent.mjs';
import { chapterRewards, stageRewards } from './lib/rewards.mjs';
import { briefPlan, checkPlan, importGuide, openBiliMedia, paradoxStageId, searchGuides } from './lib/guides.mjs';
import { executeMaa, maaHome, nativeAction, recognizeRecording, scanRoster } from './lib/maa.mjs';
import { adaptGuide, assess, normalizeRoster } from './lib/roster.mjs';
import { analyzeVideo, readWiki, searchWeb } from './lib/research.mjs';

const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
staticFiles.set('/guides.js', ['guides.js', 'text/javascript']);
function eventStream(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  res.flushHeaders();
  return event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
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
  for (const [key, max] of [['url', 2000], ['key', 4000], ['model', 250]]) {
    if (data[key] != null && (typeof data[key] !== 'string' || data[key].length > max)) throw new Error('模型配置格式有误。');
  }
  if (!data.url?.trim()) throw new Error('请先在连接设置中填写模型服务 URL。');
  return { url: data.url.trim(), key: data.key?.trim(), model: data.model?.trim(), vision: data.vision !== false };
}
function historyFrom(data) {
  if (!Array.isArray(data)) return [];
  return data.slice(-12).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')
    .map(m => ({ role: m.role, text: m.text.slice(0, 4000) }));
}

export function createServer({ getDevice = selectDevice, getHome = maaHome, native = executeMaa, recording = recognizeRecording } = {}) {
  let active = false;
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
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    try {
      if (req.method === 'GET' && staticFiles.has(req.url)) {
        const [name, type] = staticFiles.get(req.url);
        const file = await readFile(new URL('./public/' + name, import.meta.url));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return res.end(file);
      }
      if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { app: 'ArkPilot', guides:true, strategy:true, active });
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
        case '/api/guides/search': return json(res,200,{results:await searchGuides(data.query,signal,data.videoCode)});
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
      let guide = data.guide == null ? null : checkPlan(data.guide);
      const roster = data.roster ? await normalizeRoster(data.roster) : null;
      let adaptationBlocked = false;
      let formation = data.formation === true;
      const researchOnly = data.researchOnly === true;
      const direct = data.native ? nativeAction(data.native,!!guide) : null;
      if (direct && (data.readOnly === true || researchOnly)) throw new Error('当前为只读分析，请切换到允许操作再运行 Maa。');
      const config = direct ? null : modelConfig(data);
      const instruction = data.instruction?.trim();
      if (!instruction || instruction.length > 4000) throw new Error('指令长度应在 1 至 4000 字之间。');
      const limit = data.limit ?? 24;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('步数上限应为 1 至 100。');
      if (active) return json(res, 409, { error: '已有指令在执行，请在原对话中停止或等待结束。' });
      active = true;
      try {
        const device = researchOnly ? null : await getDevice(data.serial, signal);
        const home = await getHome();
        if (config) config.model = await chooseModel(config, signal);
        const emit = eventStream(res);
        const runNative = async a => {
          const paradox = (a.task === 'Copilot' || a.task === 'ParadoxCopilot') && await paradoxStageId(guide);
          if (a.task === 'ParadoxCopilot' && !paradox) throw Object.assign(new Error('请先导入目标悖论模拟的作业。'),{beforeStart:true});
          if (a.task === 'Copilot' && !paradox && (adaptationBlocked || roster && assess(guide,roster).some(s=>
            !s.choices.some(c=>c.status === '持有且满足已知要求')))) throw Object.assign(new Error('当前名册与作业尚未匹配，请先适配阵容或选择其他作业。'),{beforeStart:true});
          const observer = new AbortController();
          const watching = AbortSignal.any([signal,observer.signal]);
          let timer;
          const updateFrame = async () => {
            try {
              const frame = await devicePreview(device, watching);
              if (!watching.aborted) emit({type:'frame',...frame});
            } catch {
              // The native task monitors its own connection. Retry a missed preview on the next tick.
            }
            if (!watching.aborted) timer = setTimeout(updateFrame, 5000);
          };
          timer = setTimeout(updateFrame, 1500);
          try {
            return await native(a, {home,device,serial:data.serial,guide,formation,signal,progress:text=>emit({type:'core',text})});
          } finally {
            observer.abort();
            clearTimeout(timer);
          }
        };
        if (direct) {
          emit({type:'decision',action:direct,goal:instruction,note:'正在运行 Maa 任务'});
          await runNative(direct);
          emit({type:'applied',action:direct});
          emit({type:'end',outcome:'finish',goal:instruction,note:'Maa 已报告 ' + direct.task + ' 任务链执行结束。'});
          return res.end();
        }
        emit({ type: 'model', model: config.model });
        const guidance = {notes:typeof data.notes === 'string' ? data.notes.slice(0,6000) : '',plan:briefPlan(guide),
          roster:roster && {complete:roster.complete,operators:roster.operators.map(({name,owned,role,elite,level})=>({name,owned,role,elite,level}))}};
        const candidates = new Set(instruction.match(/\b[1-9]\d{0,9}\b/g) || []);
        if (Array.isArray(data.recentSearch)) {
          guidance.candidates = data.recentSearch.slice(0,20).filter(r => typeof r?.id === 'string' && /^[1-9]\d{0,9}$/.test(r.id))
            .map(r => ({id:r.id,title:String(r.title || '').slice(0,150)}));
          for (const r of guidance.candidates) candidates.add(r.id);
        }
        const cache = new Map();
        const excerpts = [];
        const videoNotes = [];
        const lookupGuide = async a => {
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
            const clip = await analyzeVideo(config,a,signal);
            videoNotes.push({url:clip.url,notes:clip.notes});
            guidance.notes = (clip.url+'\n'+clip.notes+'\n'+guidance.notes).slice(0,6000);
            emit({type:'video_notes',clip,notes:guidance.notes}); cache.set(key,clip); return clip;
          }
          if (a.type === 'adapt_guide') {
            adaptationBlocked = true;
            if (!roster || !guide) throw new Error('适配需要已导入的作业和当前账号的干员名册。');
            const recentRequests = historyFrom(data.history).filter(m=>m.role==='user').slice(-3).map(m=>m.text);
            const result = await adaptGuide(guide,roster,guidance.notes,
              m=>proposeTeam(config,{...m,instruction,recentRequests,wiki:excerpts.slice(-3),videos:videoNotes.slice(-2)},signal));
            if (!result.ready) return {ready:false,reason:result.reason,assessment:result.assessment};
            guide = result.plan; adaptationBlocked = false; formation = true; guidance.plan = briefPlan(guide);
            guidance.notes = (result.reason+'\n'+guidance.notes).slice(0,6000);
            emit({type:'guide_loaded',...result,notes:guidance.notes});
            return {ready:true,reason:result.reason,changes:result.changes,plan:guidance.plan};
          }
          if (a.type === 'find_guide') {
            const results = await searchGuides(a.stage,signal);
            for (const r of results) candidates.add(r.id);
            emit({type:'guide_search',stage:a.stage,results});
            return results;
          }
          if (!candidates.has(a.id)) throw new Error('请先搜索关卡，或在指令里给出具体作业号。');
          const material = await importGuide(a.id,signal);
          guide = material.plan;
          guidance.notes = (material.notes || guide.doc?.details || '').slice(0,6000);
          formation = data.formation === true;
          guidance.plan = briefPlan(guide);
          emit({type:'guide_loaded',...material});
          return guidance.plan;
        };
        await runAgent({ config, device, instruction, history: historyFrom(data.history),
          readOnly: researchOnly || data.readOnly === true, limit, signal, emit, guidance, lookupGuide, runNative:device && home ? runNative : null });
        res.end();
      } finally { active = false; }
    } catch (error) {
      if (res.destroyed) return;
      const message = signal.aborted ? '任务已停止或超时。' : error.message;
      if (!res.headersSent) return json(res, 400, { error: message });
      res.end(JSON.stringify({ type: 'error', text: message }) + '\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ARK_PORT || 17321);
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
