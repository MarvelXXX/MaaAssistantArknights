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
    if (t.plan) checkPlan(t.plan);
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
  if (!target.retryGuideIds?.length) return;
  const failed = failedGuides(row);
  if (row.review || row.status === '未完成') {
    for (const id of row.offeredGuideIds || []) failed.add(id);
  }
  return [target.guideId,...target.retryGuideIds].find(id=>id && !failed.has(id));
}

export function selectRewardTarget(targets, ledger, now) {
  const interrupted = targets.find(t=>ledger.items[t.id]?.status==='进行中');
  if (interrupted) return interrupted;
  return targets.find(t => {
    const row = ledger.items[t.id];
    const corrected = (row?.status === '未完成' || row?.status === '入口关闭') &&
      (t.revision || 0) > (row.revision || 0);
    const alternative = row?.status === '未完成' && nextRewardGuide(t,row);
    const freeRetry = alternative && t.ap === 0 && failedGuides(row).size > 0;
    return !closed.has(row?.status) && (!row?.review || alternative || corrected) && (!(row?.nextAt > now) || corrected || freeRetry) &&
      !(t.ap >= (ledger.sanityCost || 1) && ledger.sanityWait > now) && !(t.crystal && ledger.crystalWait > now && !ledger.opened[t.chapter]) &&
      t.requires.every(id => closed.has(ledger.items[id]?.status));
  });
}

export function reconcileReward(target, report, before, after) {
  if (after.prime < before.prime || after.orundum < before.orundum) return '余额下降';
  const delta = after[target.currency] - before[target.currency];
  const receivedCurrency = after.prime > before.prime || after.orundum > before.orundum;
  const obtained = target.claimAvailable === true ? receivedCurrency : delta === target.amount;
  if (report.startsWith('首通已核') && obtained) return target.claimAvailable ? '领取已核' : '首通已核';
  if (report.startsWith('原已完成') && delta === 0) return '原已完成';
  if (delta !== 0 || report.startsWith('首通已核')) return '余额待复核';
  if (report.startsWith('理智不足')) return '理智不足';
  if (report.startsWith('结晶不足')) return '结晶不足';
  if (report.startsWith('入口关闭')) return '入口关闭';
  return '未完成';
}

export async function verifiedFirstDrop(target, before, after, anchors) {
  if (!target.stage || target.claimAvailable || target.currency !== 'prime' || target.amount !== 1 ||
      !before || !after || !Number.isInteger(before.prime) || !Number.isInteger(before.orundum) ||
      after.prime !== before.prime+1 || after.orundum !== before.orundum) return false;
  const {row} = await stageAliases(target.stage);
  if (!row?.code || !row.name || row.stageId !== target.stage || !target.label.includes(row.code+' 普通 ')) return false;
  const norm = text => text.replace(/\s/g,'').toUpperCase();
  const words = new Set(anchors.filter(a=>a.source==='OCR').map(a=>norm(a.label)));
  return words.has(norm(row.code)) && words.has(norm(row.name)) && words.has('首次掉落') &&
    anchors.some(a=>a.source==='Maa' && a.label==='结算三星标志');
}

function balanceDetail(image) {
  const regions = [[0.65,0,0.34,0.13,2],[0,0.55,0.21,0.085,3]].map(([x,y,w,h,zoom]) =>
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
    const labels = frame.anchors.map(a=>a.label).join('').replace(/\s/g,'');
    const home = frame.anchors.some(a=>a.source==='Maa' && a.label==='主界面设置入口') ||
      /干员|角色管理/.test(labels) && /基建|终端|采购中心/.test(labels);
    if (home) break;
    if (attempt === 2) throw new Error('当前截图不是可核对余额的首页。');
    await delay(650,undefined,{signal});
  }
  const reply = await decide({...config,toolsUnsupported:true}, {
    instruction:'图上方是本次实机首页的货币栏，下方是账号 ID。严格用 finish，note 只写“余额 金色至纯源石整数 红色合成玉整数 游戏ID整数”，无逗号。分别读金色六边形源石图标右边、红色菱形合成玉图标右边、ID: 后面的数字，不包括龙门币、时间或加号。看不清则写“读数失败”。',
    readOnly:true, turn:1, recentSteps:[], conversation:[], remainingActions:0,
  }, {...frame,preview:balanceDetail(frame.image),anchors:[]}, signal);
  const m = /^余额\s+(\d{1,7})\s+(\d{1,9})\s+(\d{5,14})$/.exec(reply.note?.trim());
  if (!m || reply.action?.type !== 'finish') throw new Error('未读到两种首页余额。');
  return {prime:Number(m[1]), orundum:Number(m[2]), uid:m[3], image:frame.preview};
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

const numbers = wallet => ({prime:wallet.prime, orundum:wallet.orundum});

function renderProgress(manifest, ledger) {
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
    const walletLink = '['+row.status+']('+encodeURIComponent(id+'-home.jpg')+')';
    const label = {result:'结算画面',stage:'战后关卡'}[row.evidence];
    const proofLink = label ? ' · ['+label+']('+encodeURIComponent(id+'-'+row.evidence+'.jpg')+')' : '';
    lines.push('| '+at+' | '+titles.get(id)+' | '+walletLink+proofLink+' | '+row.after.prime+' | '+row.after.orundum+' |');
  }
  return lines.join('\n')+'\n';
}

export function rewardEvidence(stage) {
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
      if (text.includes('结算三星标志') && text.includes('首次掉落')) score = 4;
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
  try {
    await runCommand({...options,signal,emit:event=>{
      options.emit(event);
      if (event.type!=='frame') return;
      const text=event.anchors.map(a=>a.label).join('').replace(/\s/g,'');
      if (/登录认证已失效.{0,5}重新登录|登錄認證已失效.{0,5}重新登錄/.test(text)) {
        session.abort(Object.assign(new Error('游戏登录认证已失效。'),{code:'GAME_SESSION_EXPIRED'}));
      }
    }});
  } finally {
    options.signal.throwIfAborted();
    session.signal.throwIfAborted();
  }
}

export async function runRewardQueue({filename, serial, device, config, runCommand, emit, signal}) {
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
  const notify = text => { emit({type:'checkpoint',text}); emit({type:'core',text}); };
  const play = async (instruction, {limit, onStageEvent, expectedStage, guide, guideId, onGuideStart, resumeAfterStep, allowNative = true, fixedTeam = false}, observe = onStageEvent) => {
    let result;
    const options={instruction, limit, expectedStage, guide, guideId, onGuideStart, resumeAfterStep, allowNative, fixedTeam, signal:AbortSignal.any([signal,AbortSignal.timeout(35*minute)]), emit:e=>{
      if (e.type === 'end') { result = e; return; }
      observe?.(e);
      emit(e);
    }};
    if (onStageEvent) await runRewardStage(runCommand,options);
    else await runCommand(options);
    if (!onStageEvent && result?.outcome==='ask') throw new Error(result.note || '游戏需要手动完成原账号登录。');
    return result?.note?.trim() || '未完成';
  };
  const homeWallet = async observe => {
    const read = ()=>verifyWalletAccount(()=>captureWallet(device,config,signal),manifest.uid);
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      if (error.message.includes('UID')) throw error;
      await play('回到当前游戏账号的首页，若有结算请先观察再退出，有未结束的实战等到结算。认证失效可确认后使用设备记住的原账号快捷登录。若要求短信、扫码、密码或提示其他设备在线，停在该页并 ask。停在首页，不领取其他奖励。'+spendRule,{limit:30,allowNative:false},observe);
      return read();
    }
  };
  let wallet = await homeWallet();
  let restoredTarget;
  const imageFile = (id, type, preview) => writeFile(path.join(dir,id+'-'+type+'.jpg'),Buffer.from(preview.split(',')[1],'base64'));
  await imageFile('session','home',wallet.image);
  notify('已核对首页，至纯源石 '+wallet.prime+'，合成玉 '+wallet.orundum+'。');
  const proofNote = '首通已核：本关结算截图的关号、关名、三星与首次掉落标记吻合，同一轮首页源石增加 1，合成玉持平。';
  for (const target of manifest.targets) {
    const row = ledger.items[target.id];
    if (row?.status !== '余额待复核' || target.currency !== 'prime' || !target.stage) continue;
    const proof = path.join(dir,target.id+'-result.jpg');
    try {
      const {mtimeMs} = await stat(proof);
      const end = Date.parse(row.at);
      const start = row.started ? Date.parse(row.started) : Math.max(end-35*minute,
        ...Object.values(ledger.items).map(r=>Date.parse(r.at)).filter(at=>at<end));
      if (!(mtimeMs>=start && mtimeMs<=end+1000)) continue;
      const image = jpeg.decode(await readFile(proof),{useTArray:true});
      const client = await device.checkGame(signal);
      const {anchors} = await recognize({png:PNG.sync.write(image),width:image.width,height:image.height,client},signal);
      if (!await verifiedFirstDrop(target,row.before,row.after,anchors)) continue;
    } catch {
      signal.throwIfAborted();
      continue;
    }
    Object.assign(row,{status:'首通已核',note:proofNote,evidence:'result'});
    delete row.review;
    ledger.opened[target.chapter] = true;
    await save();
    notify(target.label+' · 已从该轮结算截图和首页账目复核首通。');
  }
  while (!signal.aborted) {
    const changed = (await stat(filename)).mtimeMs;
    if (changed !== modified) {
      const next = await loadManifest();
      if (next.account !== manifest.account || next.uid !== manifest.uid) throw new Error('账号清单已切换，需从首页重新核查。');
      manifest = next;
      modified = changed;
    }
    const t = selectRewardTarget(manifest.targets,ledger,Date.now());
    if (!t) {
      const remaining = manifest.targets.filter(item=>!closed.has(ledger.items[item.id]?.status)).length;
      if (!remaining) break;
      const future = [ledger.sanityWait,ledger.crystalWait,...Object.values(ledger.items).map(r=>r.nextAt)].filter(time=>time>Date.now());
      if (!future.length) {
        emit({type:'end',outcome:'ask',goal:'核查剩余首通',note:'还有 '+remaining+' 项需要复核作业、余额或前置条件。进度已保存。'});
        return;
      }
      const next = Math.min(...future);
      notify('等待游戏资源或关卡开放，下次检查 '+new Date(next).toLocaleString('zh-CN')+'。');
      await delay(Math.min(next-Date.now(),60*minute),undefined,{signal});
      wallet = await homeWallet();
      continue;
    }
    const previous = ledger.items[t.id] || {};
    const before = previous.status === '进行中' && previous.before ? previous.before : numbers(wallet);
    const attempts = (previous.attempts || 0) + 1;
    ledger.items[t.id] = {...previous, status:'进行中', attempts, before, started:new Date().toISOString()};
    await save();
    notify(t.label+'，第 '+attempts+' 次核查。');
    const evidence = rewardEvidence(t.stage);
    let report, usedGuide;
    const offered = new Set(previous.offeredGuideIds || []);
    const failed = failedGuides(previous);
    const credited = previous.status==='进行中' && wallet[t.currency]-before[t.currency]===t.amount;
    const caution = credited ? '上次中断后余额已增加对应金额。仅去本关详情核对完成标志，不得再次开战。' :
      previous.status === '进行中' ? '上轮中断，务必先核对本关已领取状态。' : '';
    const previousNote = previous.note ? '上次观察：'+previous.note.slice(0,450)+'。更换失败的作业或阵容。' : '';
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
      report = await play('本轮只处理 '+t.label+'。'+t.route+'。'+caution+previousNote+avoid+loaded+annihilation+
        '先确认目标关号、模式和账号完成状态。已完成就跳过。仅打一遍正式作战，普通关用相符作业、自动编队或按名册适配，剧情可免费跳过。结算/奖励/已完成标志须由实机核实。就此返回首页，勿领其他奖励。finish 的 note 必须从以下之一开始：首通已核、原已完成、理智不足、结晶不足、入口关闭、未完成，再写证据及失败作业号。若理智不足且画面可读，请写“理智不足，当前理智 X，关卡需 Y”。'+spendRule,{
          limit:75, expectedStage:t.stage, guide, guideId:guide ? candidate : undefined, onGuideStart:id=>{usedGuide=id;},
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
      report='未完成 '+error.message;
    }
    restoredTarget=undefined;
    wallet = await homeWallet(evidence.observe);
    // An interrupted successful battle may already have been credited on this run's first frame.
    if (previous.status === '进行中' && report.startsWith('原已完成') &&
        wallet[t.currency]-before[t.currency] === t.amount) report = '首通已核（中断后复核） '+report;
    let status = reconcileReward(t,report,before,wallet);
    if (status==='余额待复核' && evidence.best && await verifiedFirstDrop(t,before,wallet,evidence.best.anchors)) {
      report = proofNote;
      status = '首通已核';
    }
    await imageFile(t.id,'home',wallet.image);
    const row = ledger.items[t.id] = {status,attempts,before,after:numbers(wallet),started:ledger.items[t.id].started,note:report,at:new Date().toISOString()};
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
    else if (status === '未完成' && attempts<3) row.nextAt = Date.now()+45*minute;
    else row.review = true;
    await save();
    notify(t.label+' · '+status+'。首页 '+wallet.prime+' 源石、'+wallet.orundum+' 合成玉。');
    if (status === '余额下降') throw new Error('实机余额出现下降，已停止清单，需核对账号和账目。');
  }
  signal.throwIfAborted();
  emit({type:'end',outcome:'finish',goal:'完成首通清单',note:'清单全部已核实，最终余额 '+wallet.prime+' 源石、'+wallet.orundum+' 合成玉。'});
}
