import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { decide } from './model.mjs';
import { recognize } from './vision.mjs';
import { checkPlan, importGuide, matchesRewardStage, stageAliases } from './guides.mjs';

const minute = 60000;
const closed = new Set(['首通已核', '领取已核', '原已完成']);
const spendRule = '禁止消耗源石或合成玉，禁止兑换、充值、寻访、购买理智或切换账号。优先自然理智。仅在确认扣除的是库存理智药、源石用量为零时可用药，优先即将过期的药。';

function stoneRecovery(anchors) {
  if (anchors.some(a=>a.source==='Maa' && a.label==='源石恢复提示')) return true;
  const text = anchors.map(a=>a.label).join('').replace(/\s/g,'');
  return /是否(?:花费|消耗|使用)\d*[颗个]?(?:至纯)?源石(?:兑换|恢复)\d*点?理智/.test(text);
}

export async function dismissStoneRecovery(device, signal, observe = recognize, pause = delay) {
  await device.input({type:'back'},signal);
  let clearFrames = 0;
  for (let attempt=0; attempt<5; attempt++) {
    await pause(400,undefined,{signal});
    const frame = await observe(await device.capture(signal),signal);
    clearFrames = frame.anchors.length && !stoneRecovery(frame.anchors) ? clearFrames+1 : 0;
    if (clearFrames===2) return;
  }
  throw new Error('已按返回键，尚未核实源石恢复弹窗关闭。');
}

function validateManifest(manifest, serial) {
  if (!manifest || manifest.serial !== serial || !manifest.account || !Array.isArray(manifest.targets) || !manifest.targets.length) {
    throw new Error('设备或账号清单不匹配。');
  }
  const ids = new Set();
  for (const t of manifest.targets) {
    if (!/^[a-zA-Z0-9_#@.-]{1,100}$/.test(t.id) || ids.has(t.id) || !t.label || !t.route ||
        !Number.isInteger(t.amount) || t.amount < 1 || !['prime','orundum'].includes(t.currency) ||
        !Array.isArray(t.requires) || (t.guideId && !/^[1-9]\d{0,9}$/.test(t.guideId))) throw new Error('首通清单包含无效或重复的目标。');
    if (t.retryGuideIds != null && (!Array.isArray(t.retryGuideIds) || t.retryGuideIds.length>20 ||
        t.retryGuideIds.some(id=>typeof id!=='string' || !/^[1-9]\d{0,9}$/.test(id)))) throw new Error('备选作业号无效。');
    if (t.plan) t.plan = checkPlan(t.plan);
    if (t.resumeAfterStep != null && (!t.fixedTeam || !t.stage || !Number.isInteger(t.resumeAfterStep) ||
        t.resumeAfterStep<1 || t.resumeAfterStep>=24)) throw new Error('教学续打需要固定队、关卡和有效的作业步骤。');
    if (t.revision != null && (!Number.isSafeInteger(t.revision) || t.revision<1)) throw new Error('攻略修订号无效。');
    ids.add(t.id);
  }
  if (manifest.targets.some(t => t.requires.some(id => !ids.has(id) || id === t.id))) throw new Error('清单含未知前置关卡。');
}

function failedGuides(row) {
  const ids = new Set(row?.failedGuideIds || []);
  const legacy = row?.note?.match(/失败作业号[：:]\s*([1-9]\d{0,9})(?!\d)/);
  if (legacy) ids.add(legacy[1]);
  return ids;
}

export function nextRewardGuide(target, row) {
  if (target.plan) return;
  if (!row?.note && row?.status !== '未完成') return target.guideId;
  const failed = failedGuides(row);
  const reason = row.status==='进行中' ? row.lastStatus : row.status;
  if (['理智不足','结晶不足','模型待重试'].includes(reason) && target.guideId && !failed.has(target.guideId)) return target.guideId;
  if (!target.retryGuideIds?.length) return;
  if (row.review || row.status === '未完成') {
    for (const id of row.offeredGuideIds || []) failed.add(id);
  }
  return [target.guideId,...target.retryGuideIds].find(id=>id && !failed.has(id));
}

export function selectRewardTarget(targets, ledger, now, sanity) {
  const interrupted = targets.find(t=>ledger.items[t.id]?.status==='进行中');
  if (interrupted) return interrupted;
  const eligible = targets.filter(t => {
    const row = ledger.items[t.id];
    const corrected = (row?.status === '未完成' || row?.status === '入口关闭') &&
      (t.revision || 0) > (row.revision || 0);
    const alternative = row?.status === '未完成' && nextRewardGuide(t,row);
    const freeRetry = alternative && t.ap === 0 && failedGuides(row).size > 0;
    return !closed.has(row?.status) && (!row?.review || alternative || corrected) && (!(row?.nextAt > now) || corrected || freeRetry) &&
      !(t.ap >= (ledger.sanityCost || 1) && ledger.sanityWait > now) && !(t.crystal && ledger.crystalWait > now && !ledger.opened[t.chapter]) &&
      t.requires.every(id => closed.has(ledger.items[id]?.status));
  });
  if (Number.isInteger(sanity) && sanity >= 0 && sanity <= 999) {
    const affordable = eligible.find(t => Number.isInteger(t.ap) && t.ap >= 0 && t.ap <= sanity);
    if (affordable) return affordable;
  }
  return eligible[0];
}

export function refreshSanityWait(targets, ledger, sanity, observedAt) {
  if (!Number.isInteger(sanity) || sanity < 0 || sanity > 999 || !Number.isFinite(observedAt)) return;
  let hasKnownCost = false;
  let lowestCost = Infinity;
  let nextAt;
  for (const t of targets) {
    const row = ledger.items[t.id];
    if (row?.status !== '理智不足' || !(t.ap > 0)) continue;
    hasKnownCost = true;
    const missing = t.ap - sanity;
    if (missing <= 0) {
      delete row.nextAt;
      continue;
    }
    // Keep the existing recovery tick when the fresh reading agrees with it.
    if (Math.ceil((row.nextAt - observedAt) / (6 * minute)) !== missing) {
      row.nextAt = observedAt + missing * 6 * minute;
    }
    if (t.ap < lowestCost || (t.ap === lowestCost && row.nextAt < nextAt)) {
      lowestCost = t.ap;
      nextAt = row.nextAt;
    }
  }
  if (hasKnownCost) {
    ledger.sanityCost = nextAt ? lowestCost : undefined;
    ledger.sanityWait = nextAt;
  }
}

export function reconcileReward(target, report, before, after) {
  if (after.prime < before.prime || after.orundum < before.orundum) return '余额下降';
  const delta = after[target.currency] - before[target.currency];
  const receivedCurrency = after.prime > before.prime || after.orundum > before.orundum;
  const claim = target.claimAvailable === true;
  const changed = claim ? receivedCurrency : delta !== 0;
  const reported = report.startsWith('首通已核') || (claim && report.startsWith('领取已核'));
  if (reported && (claim ? receivedCurrency : delta === target.amount)) return claim ? '领取已核' : '首通已核';
  if (report.startsWith('原已完成') && !changed) return '原已完成';
  if (changed || reported) return '余额待复核';
  if (report.startsWith('理智不足')) return '理智不足';
  if (report.startsWith('结晶不足')) return '结晶不足';
  if (report.startsWith('入口关闭')) return '入口关闭';
  if (report.startsWith('模型待重试')) return '模型待重试';
  return '未完成';
}

export async function verifiedFirstDrop(target, before, after, anchors) {
  if (!target.stage || target.claimAvailable || target.currency !== 'prime' || target.amount !== 1 ||
      !before || !after || !Number.isInteger(before.prime) || !Number.isInteger(before.orundum) ||
      after.prime !== before.prime+1 || after.orundum !== before.orundum) return false;
  const {row} = await stageAliases(target.stage);
  if (!row?.code || !row.name || row.stageId !== target.stage) return false;
  const challenge = target.stage.endsWith('#f#');
  if (!target.label.includes(row.code+(challenge ? ' 突袭／遭遇 ' : ' 普通 '))) return false;
  const norm = text => text.replace(/\s/g,'').toUpperCase();
  const words = new Set(anchors.filter(a=>a.source==='OCR').map(a=>norm(a.label)));
  return words.has(norm(row.code)) && words.has(norm(row.name)) && words.has('首次掉落') &&
    anchors.some(a=>a.source==='Maa' && a.label===(challenge ? '磨难结算标志' : '结算三星标志'));
}

function receivedItem(anchors, name, amount) {
  return anchors.some(item => {
    if (item.label !== name || !item.box) return false;
    const [x,y,width,height] = item.box;
    return anchors.some(count => {
      if (!count.box || count.label.replace(/[,，]/g,'') !== String(amount)) return false;
      const [cx,cy,cw,ch] = count.box;
      const above = y+height/2-(cy+ch/2);
      return above>height && above<height*4 && Math.abs(cx+cw/2-(x+width/2))<=height*2;
    });
  });
}

function completedParadox(anchors, name) {
  if (!name || !anchors.some(a=>a.source==='Maa' && a.label==='悖论模拟开始按钮')) return false;
  const words = anchors.filter(a=>a.source==='OCR').map(a=>a.label.replace(/\s/g,''));
  if (words.includes('公开招募') && words.some(word=>/采购中心|干员寻访|档案/.test(word))) return false;
  return words.includes('悖论模拟') && words.includes(name.replace(/\s/g,'')) &&
    words.some(word=>word.replace(/^[\p{P}\p{S}]+/u,'')==='已完成模拟作战');
}

function paradoxCredit(target, before, after) {
  return !target.claimAvailable && target.stage?.startsWith('mem_') && target.currency==='orundum' && target.amount===200 &&
    Number.isSafeInteger(before?.prime) && Number.isSafeInteger(before?.orundum) &&
    after?.prime===before.prime && after.orundum===before.orundum+200;
}

export function needsParadoxVisit(target, row, anchors) {
  return row.status==='余额待复核' && paradoxCredit(target,row.before,row.after) &&
    anchors.some(a=>a.source==='Maa' && a.label==='结算三星标志') &&
    anchors.some(a=>a.source==='OCR' && a.label.replace(/\s/g,'')==='首次掉落');
}

export async function visitParadoxDetail(runCommand, target, name, signal, emit, captureStable, keepAttempt) {
  const stopped = new AbortController();
  let detail, candidate;
  try {
    await runCommand({instruction:'只核对 '+target.label+' 的悖论模拟完成状态。从首页进入干员列表、干员本人、档案、悖论模拟，停在详情页即可。禁止开战、养成、消费、领取任何物品或切换账号。'+spendRule,
      limit:24,allowNative:false,signal:AbortSignal.any([signal,stopped.signal,AbortSignal.timeout(8*minute)]),
      emit:event=>{
        if (event.type!=='end') emit(event);
        if (event.type!=='frame') return;
        const anchors=event.anchors;
        // Stop on the detail screen before the planner can tap Start, even for a different operator.
        const start=anchors.some(a=>a.source==='Maa' && a.label==='悖论模拟开始按钮');
        const detailText=anchors.some(a=>a.source==='OCR' && a.label.includes('开始模拟'));
        if (stoneRecovery(anchors)) { stopped.abort(); return; }
        if (!start && !detailText) return;
        candidate=event;
        if (completedParadox(anchors,name)) detail=event.preview;
        stopped.abort();
      }});
  } catch (error) {
    signal.throwIfAborted();
    if (!stopped.signal.aborted) throw error;
  }
  for (let i=0; candidate && !detail && captureStable && i<3; i++) {
    const frame=await captureStable();
    if (stoneRecovery(frame.anchors)) break;
    candidate=frame;
    if (completedParadox(frame.anchors,name)) detail=frame.preview;
  }
  if (candidate && !detail) await keepAttempt?.(candidate.preview);
  return detail;
}

export async function rewardReceipt(target, before, after, anchors) {
  if (!target.claimAvailable) {
    if (await verifiedFirstDrop(target,before,after,anchors))
      return {status:'首通已核',note:'首通已核：本关结算截图的关号、关名、难度对应的胜利标志与首次掉落标记吻合，同一轮首页源石增加 1，合成玉持平。'};
    if (paradoxCredit(target,before,after)) {
      const {row} = await stageAliases(target.stage);
      if (row?.stageId===target.stage && row.levelId.startsWith('obt/memory/') &&
          completedParadox(anchors,row.name))
        return {status:'首通已核',note:'首通已核：悖论模拟「'+row.name+'」的关卡页显示已完成模拟作战，同一轮首页合成玉增加 200，源石持平。'};
    }
    return;
  }
  const words = anchors.filter(a=>a.source==='OCR').map(a=>({...a,label:a.label.replace(/\s/g,'')}));
  if (!before || !after || !words.some(a=>a.label==='获得物资')) return;
  const gains = [];
  for (const [currency,name] of [['prime','至纯源石'],['orundum','合成玉']]) {
    if (!Number.isSafeInteger(before[currency]) || !Number.isSafeInteger(after[currency])) return;
    const amount = after[currency]-before[currency];
    if (amount<0) return;
    if (amount===0) continue;
    if (!receivedItem(words,name,amount)) return;
    gains.push(name+' ×'+amount);
  }
  if (gains.length) return {status:'领取已核',note:'领取已核：获得物资画面中的 '+gains.join('、')+' 与本轮首页余额增量吻合。'};
}

function balanceDetail(image) {
  const regions = [[0.65,0,0.34,0.13,2],[0,0.55,0.21,0.085,3],[0.55,0.14,0.17,0.24,2]].map(([x,y,w,h,zoom]) =>
    ({x:Math.floor(x*image.width),y:Math.floor(y*image.height),w:Math.floor(w*image.width),h:Math.floor(h*image.height),zoom}));
  const width = Math.max(...regions.map(r=>r.w*r.zoom));
  const height = regions.reduce((sum,r)=>sum+r.h*r.zoom,0);
  const data = Buffer.alloc(width*height*4);
  let top = 0;
  for (const {x,y,w,h,zoom} of regions) {
    for (let line=0;line<h;line++) {
      const src=((y+line)*image.width+x)*4, dst=(top+line*zoom)*width*4;
      for (let col=0;col<w;col++) {
        const rgba=image.data.readUInt32LE(src+col*4);
        for (let j=0;j<zoom;j++) data.writeUInt32LE(rgba,dst+(col*zoom+j)*4);
      }
      for (let j=1;j<zoom;j++) data.copy(data,dst+j*width*4,dst,dst+w*zoom*4);
    }
    top += h*zoom;
  }
  return 'data:image/jpeg;base64,'+jpeg.encode({width,height,data},94).data.toString('base64');
}

async function captureWallet(device, config, signal) {
  let frame;
  for (let attempt=0;attempt<3;attempt++) {
    frame = await recognize(await device.capture(signal), signal);
    if (stoneRecovery(frame.anchors)) throw Object.assign(new Error('正在显示源石恢复理智的确认框。'),{code:'STONE_RECOVERY'});
    const labels = frame.anchors.map(a=>a.label).join('').replace(/\s/g,'');
    const home = frame.anchors.some(a=>a.source==='Maa' && a.label==='主界面设置入口') ||
      /干员|角色管理/.test(labels) && /基建|终端|采购中心/.test(labels);
    if (home) break;
    if (attempt === 2) throw Object.assign(new Error('当前截图不是可核对余额的首页。'), {code:'NOT_HOME'});
    await delay(650,undefined,{signal});
  }
  const observedAt = Date.now();
  const reply = await decide({...config,toolsUnsupported:true}, {
    instruction:'图从上到下依次为首页货币栏、账号 ID、终端理智。严格用 finish，note 只写“余额 金色至纯源石整数 红色合成玉整数 游戏ID整数 当前理智整数”，无逗号。金色六边形和红色菱形各读图标右侧数字，ID 读 ID: 后的数字。这三项看不清写“读数失败”。当前理智读终端旁的大号数字，不读斜线后的上限；仅理智看不清时最后一项写 ?。',
    readOnly:true, turn:1, recentSteps:[], conversation:[], remainingActions:0,
  }, {...frame,preview:balanceDetail(frame.image),anchors:[]}, signal);
  const m = /^余额\s+(\d{1,7})\s+(\d{1,9})\s+(\d{5,14})(?:\s+(\d{1,3}|\?))?$/.exec(reply.note?.trim());
  if (!m || reply.action?.type !== 'finish') throw Object.assign(new Error('未读到两种首页余额。'), {code:'WALLET_UNREADABLE'});
  return {prime:Number(m[1]), orundum:Number(m[2]), uid:m[3], sanity:m[4] && m[4]!=='?' ? Number(m[4]) : undefined,
    observedAt, image:frame.preview};
}

export async function readWalletWithRetry(capture, signal, notify, pause = delay) {
  for (let attempt=0; ; attempt++) {
    signal.throwIfAborted();
    try { return await capture(); }
    catch (error) {
      signal.throwIfAborted();
      if (!['MODEL_TEMPORARY','WALLET_UNREADABLE'].includes(error.code) || attempt>=2) throw error;
      const seconds = error.code==='MODEL_TEMPORARY' ? [10,30][attempt] : 1;
      notify(error.message+' '+seconds+' 秒后重新截图核对首页余额。');
      await pause(seconds*1000,undefined,{signal});
    }
  }
}

export async function waitForWalletModel(read, signal, notify, pause = delay) {
  const intervals = [2, 5, 15];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      if (error.code !== 'MODEL_TEMPORARY') throw error;
      const minutes = intervals[Math.min(attempt, intervals.length - 1)];
      notify('模型连接仍未恢复，后台清单暂停操作。'+minutes+' 分钟后从新截图核对首页和账号。');
      await pause(minutes * minute, undefined, { signal });
    }
  }
}

export async function verifyWalletAccount(capture, uid) {
  const first=await capture();
  if (!uid || first.uid===String(uid)) return first;
  // Recheck using fresh frames, keeping the expected ID out of the model prompt.
  for (let i=0;i<2;i++) {
    let fresh;
    try { fresh=await capture(); }
    catch (error) { throw new Error('未能复核游戏 UID，已停止。',{cause:error}); }
    if (fresh.uid!==String(uid)) break;
    if (i===1) return fresh;
  }
  throw new Error('连续读取首页仍不能核对游戏 UID，已停止。');
}

const numbers = wallet => ({prime:wallet.prime, orundum:wallet.orundum, ...(wallet.sanity == null ? {} : {sanity:wallet.sanity})});

export function rewardWalletContext(before, current, previousNote) {
  const balance = wallet => wallet.prime+' 源石、'+wallet.orundum+' 合成玉';
  let context = '本项目标开始时首页实测余额为 '+balance(before)+'。本项收益只比较这个起点和结束时的首页余额。';
  if (before.prime !== current.prime || before.orundum !== current.orundum) {
    context += '恢复任务时首页实测为 '+balance(current)+'，请结合本关结算或完成标志核对。';
  }
  if (previousNote) context += '以下历史记录仅用于定位关卡、材料和作业，里面的余额属于上次核查：'+previousNote.slice(0,450)+'。';
  return context;
}

export function renderProgress(manifest, ledger) {
  const titles = new Map(manifest.targets.map(t=>[t.id,t.label.replace(/[|\r\n]/g,' ')]));
  const rows = Object.entries(ledger.items).filter(([id])=>titles.has(id));
  const cleared = rows.filter(([,r])=>r.status==='首通已核').length;
  const claimed = rows.filter(([,r])=>r.status==='领取已核').length;
  const prior = rows.filter(([,r])=>r.status==='原已完成').length;
  const current = rows.find(([,r])=>r.status==='进行中');
  const finished = rows.filter(([,r])=>r.at).sort((a,b)=>b[1].at.localeCompare(a[1].at));
  const latest = finished[0]?.[1]?.after || current?.[1]?.before;
  const lines = ['# 首通执行记录','',
    '清单共 '+manifest.targets.length+' 项，其中本次确认首通 '+cleared+' 项、领取免费奖励 '+claimed+' 项，已完成或已无可领奖励 '+prior+' 项。',
    '', '最近核对的首页余额为 '+(latest ? latest.prime+' 源石、'+latest.orundum+' 合成玉。':'待核。'),
    '',current ? '最近开始核查的目标为 '+titles.get(current[0])+'。':'各项状态见下表。',
    '', '| 时间（北京时间） | 关卡 | 核验结果 | 源石 | 合成玉 |','| --- | --- | --- | ---: | ---: |'];
  for (const [id,row] of finished) {
    const at = new Date(row.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    const result = row.status === '进行中' ? (row.lastStatus || '上次核查') : row.status;
    const walletLink = '['+result+']('+encodeURIComponent(id+'-home.jpg')+')';
    const label = {result:'结算画面',stage:'战后关卡'}[row.evidence];
    let proofLink = label ? ' · ['+label+']('+encodeURIComponent(id+'-'+row.evidence+'.jpg')+')' : '';
    if (row.detailVerifiedAt) proofLink+=' · [复核关卡]('+encodeURIComponent(id+'-detail.jpg')+')';
    lines.push('| '+at+' | '+titles.get(id)+' | '+walletLink+proofLink+' | '+row.after.prime+' | '+row.after.orundum+' |');
  }
  return lines.join('\n')+'\n';
}

export function rewardEvidence(stage, claimAvailable = false, paradoxName) {
  let battleSeen = false, best;
  return {
    observe(event) {
      if (event.type === 'applied' && ['Copilot','ParadoxCopilot','Fight'].includes(event.action?.task)) battleSeen = true;
      if (event.type !== 'frame' || !event.preview) return;
      const text = event.anchors.map(a=>a.label).join('').replace(/\s/g,'');
      if (text.includes('战斗防御点图标')) battleSeen = true;
      // The home navigation overlay leaves the stage and its reward text visible underneath.
      if (text.includes('公开招募') && /采购中心|干员寻访|档案/.test(text)) return;
      let score;
      if (claimAvailable && text.includes('获得物资') && /至纯源石|合成玉/.test(text)) score = 5;
      else if (battleSeen && completedParadox(event.anchors,paradoxName)) score = 5;
      else if (text.includes(stage?.endsWith('#f#') ? '磨难结算标志' : '结算三星标志') && text.includes('首次掉落')) score = 4;
      else if (/获得物资|结算三星标志|结算二星标志|磨难结算标志|行动结束/.test(text)) score = 3;
      else if (text.includes('已完成模拟作战')) score = 2;
      else if (battleSeen && stage?.startsWith('mem_') && /悖论模拟开始按钮|开始模拟/.test(text)) score = 1;
      if (score && (!best || score > best.score)) best = {score,kind:score === 1 ? 'stage' : 'result',preview:event.preview,anchors:event.anchors};
    },
    get best() { return best; },
  };
}

export async function runRewardStage(runCommand,options) {
  const session = new AbortController();
  const signal = AbortSignal.any([options.signal,session.signal]);
  let available;
  try {
    await runCommand({...options,signal,emit:event=>{
      options.emit(event);
      if (options.ap>0 && event.type==='decision') {
        const match = event.note?.match(/当前(?:自然)?理智(?:为|是)?\s*(\d{1,3})(?!\d)/);
        if (match) available = Number(match[1]);
      }
      if (event.type!=='frame') return;
      const text=event.anchors.map(a=>a.label).join('').replace(/\s/g,'');
      if (/登录认证已失效.{0,5}重新登录|登錄認證已失效.{0,5}重新登錄/.test(text)) {
        session.abort(Object.assign(new Error('游戏登录认证已失效。'),{code:'GAME_SESSION_EXPIRED'}));
      } else if (options.ap>0 && stoneRecovery(event.anchors)) {
        const counts = available<options.ap ? '，当前理智 '+available+'，关卡需 '+options.ap : '';
        session.abort(Object.assign(new Error('理智不足'+counts+'。检测到源石恢复确认框，本次作战未使用源石。'),{code:'STONE_RECOVERY'}));
      }
    }});
  } finally {
    options.signal.throwIfAborted();
    session.signal.throwIfAborted();
  }
}

export async function runRewardQueue({filename, serial, device, config, runCommand, emit, signal, background = false}) {
  async function loadManifest() {
    const data = JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));
    validateManifest(data,serial);
    return data;
  }
  let modified = (await stat(filename)).mtimeMs;
  let manifest = await loadManifest();
  const dir = filename + '.run';
  await mkdir(dir,{recursive:true});
  const checkpoint = path.join(dir,'progress.json');
  let ledger;
  try { ledger = JSON.parse(await readFile(checkpoint,'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ledger = {serial, account:manifest.account, opened:{}, items:{}};
  }
  if (ledger.serial !== serial || ledger.account !== manifest.account) throw new Error('已有进度属于其他设备或账号。');
  const save = async () => {
    await writeFile(checkpoint+'.tmp', JSON.stringify(ledger,null,2));
    await rename(checkpoint+'.tmp',checkpoint);
    const report = path.join(dir,'首通进度.md');
    await writeFile(report+'.tmp',renderProgress(manifest,ledger));
    await rename(report+'.tmp',report);
  };
  const notify = text => emit({type:'checkpoint',text});
  const play = async (instruction, {limit, onStageEvent, ap, expectedStage, guide, guideId, onGuideStart, resumeAfterStep, allowNative = true, fixedTeam = false}, observe = onStageEvent) => {
    let result;
    const options={instruction, limit, ap, expectedStage, guide, guideId, onGuideStart, resumeAfterStep, allowNative, fixedTeam, signal:AbortSignal.any([signal,AbortSignal.timeout(35*minute)]), emit:e=>{
      if (e.type === 'end') { result = e; return; }
      observe?.(e);
      emit(e);
    }};
    if (onStageEvent) await runRewardStage(runCommand,options);
    else await runCommand(options);
    if (!onStageEvent && result?.outcome==='ask') throw new Error(result.note || '游戏需要手动完成原账号登录。');
    return result?.note?.trim() || '未完成';
  };
  const readHomeWallet = async observe => {
    const capture = ()=>readWalletWithRetry(()=>captureWallet(device,config,signal),signal,notify);
    const read = ()=>verifyWalletAccount(capture,manifest.uid);
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      if (error.code!=='NOT_HOME' && error.code!=='STONE_RECOVERY') throw error;
      let instruction = '回到当前游戏账号的首页，若有结算请先观察再退出，有未结束的实战等到结算。认证失效可确认后使用设备记住的原账号快捷登录。若要求短信、扫码、密码或提示其他设备在线，停在该页并 ask。停在首页，不领取其他奖励。'+spendRule;
      if (error.code==='STONE_RECOVERY') {
        await dismissStoneRecovery(device,signal);
        notify('已核实源石恢复弹窗关闭。正在返回首页核对余额。');
        instruction='源石恢复弹窗已经取消。现在从当前关卡详情返回首页：先打开左上方房屋图标的快捷导航，再点左侧首页，确认真实首页已经出现后 finish。只做返回导航，禁止再次点击开始行动、补充理智、消费源石或合成玉、领取其他奖励。';
      }
      await play(instruction,{limit:30,allowNative:false},observe);
      return read();
    }
  };
  const homeWallet = observe => background
    ? waitForWalletModel(() => readHomeWallet(observe), signal, notify)
    : readHomeWallet(observe);
  let wallet = await homeWallet();
  let restoredTarget;
  const imageFile = (id, type, preview) => writeFile(path.join(dir,id+'-'+type+'.jpg'),Buffer.from(preview.split(',')[1],'base64'));
  await imageFile('session','home',wallet.image);
  notify('已核对首页，至纯源石 '+wallet.prime+'，合成玉 '+wallet.orundum+
    (wallet.sanity == null ? '' : '，当前理智 '+wallet.sanity)+'。');
  const visits = [];
  for (const target of manifest.targets) {
    const row = ledger.items[target.id];
    if (row?.status !== '余额待复核' || (!target.claimAvailable && !target.stage)) continue;
    const kind = row.evidence==='stage' ? 'stage' : 'result';
    const proof = path.join(dir,target.id+'-'+kind+'.jpg');
    let verified;
    try {
      const {mtimeMs} = await stat(proof);
      const end = Date.parse(row.at);
      const start = row.started ? Date.parse(row.started) : Math.max(end-35*minute,
        ...Object.values(ledger.items).map(r=>Date.parse(r.at)).filter(at=>at<end));
      if (!(mtimeMs>=start && mtimeMs<=end+1000)) continue;
      const image = jpeg.decode(await readFile(proof),{useTArray:true});
      const client = await device.checkGame(signal);
      const {anchors} = await recognize({png:PNG.sync.write(image),width:image.width,height:image.height,client},signal);
      verified = await rewardReceipt(target,row.before,row.after,anchors);
      if (!verified) {
        if (needsParadoxVisit(target,row,anchors)) visits.push(target);
        continue;
      }
    } catch {
      signal.throwIfAborted();
      continue;
    }
    Object.assign(row,verified,{evidence:kind});
    delete row.review;
    ledger.opened[target.chapter] = true;
    await save();
    notify(target.label+' · '+verified.status+'。已核对本轮截图和首页账目。');
  }
  while (!signal.aborted) {
    const changed = (await stat(filename)).mtimeMs;
    if (changed !== modified) {
      const next = await loadManifest();
      if (next.account !== manifest.account || next.uid !== manifest.uid) throw new Error('账号清单已切换，需从首页重新核查。');
      manifest = next;
      modified = changed;
    }
    refreshSanityWait(manifest.targets,ledger,wallet.sanity,wallet.observedAt);
    if (visits.length && !Object.values(ledger.items).some(row=>row.status==='进行中')) {
      const target=visits.shift(), row=ledger.items[target.id];
      const {row:stage}=await stageAliases(target.stage);
      if (!stage?.name || stage.stageId!==target.stage || !stage.levelId.startsWith('obt/memory/')) continue;
      notify('复核 '+target.label+' 的已完成标志，仅查看详情。');
      let detail;
      try {
        detail=await visitParadoxDetail(runCommand,target,stage.name,signal,emit,async()=>{
          await delay(650,undefined,{signal});
          return recognize(await device.capture(signal),signal);
        },preview=>imageFile(target.id,'detail-attempt',preview));
      }
      catch (error) { signal.throwIfAborted(); notify('关卡详情复核未完成。'+error.message); }
      const beforeVisit=wallet;
      wallet=await homeWallet();
      if (detail && wallet.prime===beforeVisit.prime && wallet.orundum===beforeVisit.orundum) {
        await imageFile(target.id,'detail',detail);
        row.status='首通已核';
        row.note='首通已核：原结算显示三星和首次掉落，同轮首页合成玉增加 200、源石持平。复查本人悖论模拟「'+stage.name+'」已完成，复查前后两项余额均持平。';
        row.detailVerifiedAt=new Date().toISOString();
        delete row.review;
        ledger.opened[target.chapter]=true;
        await save();
        notify(target.label+' · 首通已核。原结算和复核关卡画面已保存。');
      } else notify(target.label+' · 保留待复核，尚未取得完整的同名完成标志与复查余额。');
      continue;
    }
    const t = selectRewardTarget(manifest.targets,ledger,Date.now(),wallet.sanity);
    if (!t) {
      const remaining = manifest.targets.filter(item=>!closed.has(ledger.items[item.id]?.status)).length;
      if (!remaining) break;
      const future = [ledger.sanityWait,ledger.crystalWait,...Object.values(ledger.items).map(r=>r.nextAt)].filter(time=>time>Date.now());
      if (!future.length) {
        emit({type:'end',outcome:'ask',goal:'核查剩余首通',note:'还有 '+remaining+' 项需要复核作业、余额或前置条件。进度已保存。'});
        return;
      }
      const next = Math.min(...future);
      await save();
      notify('等待游戏资源或关卡开放，下次检查 '+new Date(next).toLocaleString('zh-CN')+'。');
      await delay(Math.min(next-Date.now(),60*minute),undefined,{signal});
      wallet = await homeWallet();
      continue;
    }
    const previous = ledger.items[t.id] || {};
    const before = previous.status === '进行中' && previous.before ? previous.before : numbers(wallet);
    const attempts = (previous.attempts || 0) + 1;
    ledger.items[t.id] = {...previous, status:'进行中', attempts, before, started:new Date().toISOString()};
    // The existing timestamp, balance and screenshots belong to the last settled attempt.
    if (previous.at && previous.status !== '进行中') ledger.items[t.id].lastStatus = previous.status;
    await save();
    notify(t.label+'，第 '+attempts+' 次核查。');
    const paradoxName = t.stage?.startsWith('mem_') ? (await stageAliases(t.stage)).row?.name : undefined;
    const evidence = rewardEvidence(t.stage,t.claimAvailable,paradoxName);
    let report, usedGuide;
    const offered = new Set(previous.offeredGuideIds || []);
    const failed = failedGuides(previous);
    const credited = previous.status==='进行中' && wallet[t.currency]-before[t.currency]===t.amount;
    let caution = '';
    if (previous.status === '进行中') {
      if (t.claimAvailable) caution = '上轮中断，先核实本项是否已领取，以及是否还有未领取档位。';
      else caution = credited ? '上次中断后余额已增加对应金额。仅去本关详情核对完成标志，不得再次开战。' : '上轮中断，务必先核对本关已领取状态。';
    }
    const walletContext = rewardWalletContext(before,wallet,previous.note);
    const avoid = failed.size ? '之前未通过的作业号：'+[...failed].join('、')+'。' : '';
    try {
      let guide = t.plan;
      const candidate = nextRewardGuide(t,previous);
      if (candidate) {
        offered.add(candidate);
        try { guide = (await importGuide(candidate,signal)).plan; }
        catch { signal.throwIfAborted(); }
      }
      if (guide && (!t.stage || !await matchesRewardStage(guide,t.stage))) throw new Error('预载作业与本项目标不符。');
      if (guide) emit({type:'guide_loaded',plan:guide,source:candidate ? 'PRTS #'+candidate : '本地 JSON'});
      const source = candidate ? '（PRTS #'+candidate+'）' : '';
      const loaded = guide ? '已按真实关号载入作业'+source+'。优先用当前附件；如果名册、技能或练度不符，开战前可直接用 adapt_guide 换人，或用 find_guide 查找本关其他作业再 load_guide。若适配失败仍可换作业。' : '';
      const annihilation = t.stage?.startsWith('camp_') ? '本项核查剿灭数的一次性奖励。旧剿灭的剿灭战模拟也可打进度奖励。先在情报汇总核对档位、开启时间和开始行动按钮。周报酬已满或当前委托是另一张地图仍可打已开放的模拟。' : '';
      const instructions = t.claimAvailable
        ? '在指定入口领取免费奖励。任务有连续档位时，收取当前已完成的任务活跃度，确认随附物资，再查看新出现的可领档位，直到目标货币到账或确无可领进度。记录目标货币数量和领取画面并返回首页。finish 用“领取已核”报告目标奖励到账，用“原已完成”报告此前已领或入口已清空。尚未达标时用“未完成”并写出实际剩余条件。'
        : (failed.size ? '更换失败的作业或阵容。' : '')+
          '先确认目标关号、模式和账号完成状态。已完成就跳过。仅打一遍正式作战，普通关用相符作业、自动编队或按名册适配，剧情可免费跳过。结算/奖励/已完成标志须由实机核实。就此返回首页，勿领其他奖励。finish 的 note 必须从以下之一开始：首通已核、原已完成、理智不足、结晶不足、入口关闭、未完成，再写证据及失败作业号。若理智不足且画面可读，请写“理智不足，当前理智 X，关卡需 Y”。';
      report = await play('本轮只处理 '+t.label+'。'+walletContext+caution+t.route+'。'+avoid+loaded+annihilation+instructions+spendRule,{
          limit:75, ap:t.ap, expectedStage:t.stage, guide, guideId:guide ? candidate : undefined, onGuideStart:id=>{usedGuide=id;},
          resumeAfterStep:t.resumeAfterStep, allowNative:!credited && t.useNative!==false, fixedTeam:t.fixedTeam===true,
          onStageEvent:evidence.observe,
        });
    } catch (error) {
      signal.throwIfAborted();
      if (error.code==='GAME_SESSION_EXPIRED') {
        if (restoredTarget===t.id) throw new Error('同一关再次出现登录认证失效，已保留进度。');
        notify('游戏登录认证失效，保留本局记录。正在恢复原账号并核对到账情况。');
        wallet=await homeWallet();
        restoredTarget=t.id;
        continue;
      }
      if (error.code==='STONE_RECOVERY') report=error.message;
      else report=(error.code==='MODEL_TEMPORARY' ? '模型待重试 ' : '未完成 ')+error.message;
    }
    restoredTarget=undefined;
    wallet = await homeWallet(evidence.observe);
    // An interrupted successful battle may already have been credited on this run's first frame.
    if (!t.claimAvailable && previous.status === '进行中' && report.startsWith('原已完成') &&
        wallet[t.currency]-before[t.currency] === t.amount) report = '首通已核（中断后复核） '+report;
    let status = reconcileReward(t,report,before,wallet);
    if (status==='余额待复核' && evidence.best) {
      const verified = await rewardReceipt(t,before,wallet,evidence.best.anchors);
      if (verified) {
        report = verified.note;
        status = verified.status;
      }
    }
    await imageFile(t.id,'home',wallet.image);
    const row = ledger.items[t.id] = {status,attempts,before,after:numbers(wallet),started:ledger.items[t.id].started,note:report,at:new Date().toISOString()};
    if (evidence.best && needsParadoxVisit(t,row,evidence.best.anchors)) visits.push(t);
    if (evidence.best) {
      await imageFile(t.id,evidence.best.kind,evidence.best.preview);
      row.evidence = evidence.best.kind;
    }
    if (t.revision) row.revision = t.revision;
    if (usedGuide && status==='未完成') failed.add(usedGuide);
    if (failed.size) row.failedGuideIds = [...failed];
    if (offered.size) row.offeredGuideIds = [...offered];
    if (closed.has(status)) ledger.opened[t.chapter] = true;
    else if (status === '理智不足') {
      const observed = report.match(/^理智不足[，,:：\s]+当前理智\s*(\d{1,3})(?!\d)/);
      ledger.sanityCost = t.ap || 1;
      const missing = observed ? Math.max(1,ledger.sanityCost-Number(observed[1])) : 1;
      ledger.sanityWait = row.nextAt = Date.now()+missing*6*minute;
    }
    else if (status === '结晶不足') ledger.crystalWait = row.nextAt = Date.now()+24*60*minute;
    else if (status === '入口关闭') row.nextAt = Date.now()+24*60*minute;
    else if (status === '模型待重试') row.nextAt = Date.now()+5*minute;
    else if (status === '未完成' && attempts<3) row.nextAt = Date.now()+45*minute;
    else row.review = true;
    await save();
    notify(t.label+' · '+status+'。首页 '+wallet.prime+' 源石、'+wallet.orundum+' 合成玉。');
    if (status === '余额下降') throw new Error('实机余额出现下降，已停止清单，需核对账号和账目。');
  }
  signal.throwIfAborted();
  emit({type:'end',outcome:'finish',goal:'完成首通清单',note:'清单全部已核实，最终余额 '+wallet.prime+' 源石、'+wallet.orundum+' 合成玉。'});
}
