import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import jpeg from 'jpeg-js';
import { decide } from './model.mjs';
import { recognize } from './vision.mjs';

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
        !Array.isArray(t.requires)) throw new Error('首通清单包含无效或重复的目标。');
    ids.add(t.id);
  }
  if (manifest.targets.some(t => t.requires.some(id => !ids.has(id) || id === t.id))) throw new Error('清单含未知前置关卡。');
}

export function selectRewardTarget(targets, ledger, now) {
  return targets.find(t => {
    const row = ledger.items[t.id];
    return !closed.has(row?.status) && !row?.review && !(row?.nextAt > now) &&
      !(t.ap > 0 && ledger.sanityWait > now) && !(t.crystal && ledger.crystalWait > now && !ledger.opened[t.chapter]) &&
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

function balanceDetail(image) {
  const regions = [[0.65,0,0.34,0.16],[0,0.53,0.24,0.11]].map(([x,y,w,h]) =>
    [Math.floor(x*image.width),Math.floor(y*image.height),Math.floor(w*image.width),Math.floor(h*image.height)]);
  const width = Math.max(...regions.map(r=>r[2]));
  const height = regions.reduce((sum,r)=>sum+r[3],0);
  const data = Buffer.alloc(width*height*4);
  let top = 0;
  for (const [x,y,w,h] of regions) {
    for (let line=0;line<h;line++) {
      const start = ((y+line)*image.width+x)*4;
      image.data.copy(data,((top+line)*width)*4,start,start+w*4);
    }
    top += h;
  }
  return 'data:image/jpeg;base64,'+jpeg.encode({width,height,data},94).data.toString('base64');
}

async function readWallet(device, config, signal, uid) {
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
  if (uid && m[3] !== String(uid)) throw new Error('当前游戏 UID 与清单不匹配，已停止。');
  return {prime:Number(m[1]), orundum:Number(m[2]), image:frame.preview};
}

const numbers = wallet => ({prime:wallet.prime, orundum:wallet.orundum});

function renderProgress(manifest, ledger) {
  const titles = new Map(manifest.targets.map(t=>[t.id,t.label.replace(/[|\r\n]/g,' ')]));
  const rows = Object.entries(ledger.items);
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
    lines.push('| '+at+' | '+titles.get(id)+' | ['+row.status+']('+encodeURIComponent(id+'-home.jpg')+') | '+row.after.prime+' | '+row.after.orundum+' |');
  }
  return lines.join('\n')+'\n';
}

export async function runRewardQueue({filename, serial, device, config, runCommand, emit, signal}) {
  const manifest = JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));
  validateManifest(manifest, serial);
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
  const play = async (instruction, limit, onFrame, expectedStage) => {
    let result;
    await runCommand({instruction, limit, expectedStage, signal:AbortSignal.any([signal,AbortSignal.timeout(35*minute)]), emit:e=>{
      if (e.type === 'end') { result = e; return; }
      if (e.type === 'frame') onFrame?.(e);
      emit(e);
    }});
    return result?.note?.trim() || '未完成';
  };
  const homeWallet = async () => {
    try { return await readWallet(device,config,signal,manifest.uid); }
    catch (error) {
      signal.throwIfAborted();
      if (error.message.includes('UID')) throw error;
      await play('回到当前游戏账号的首页，若有结算请先观察再退出，有未结束的实战等到结算。仅可用原账号正常快捷登录。停在首页，不领取其他奖励。'+spendRule,30);
      return readWallet(device,config,signal,manifest.uid);
    }
  };
  let wallet = await homeWallet();
  const imageFile = (id, type, preview) => writeFile(path.join(dir,id+'-'+type+'.jpg'),Buffer.from(preview.split(',')[1],'base64'));
  await imageFile('session','home',wallet.image);
  notify('已核对首页，至纯源石 '+wallet.prime+'，合成玉 '+wallet.orundum+'。');
  while (!signal.aborted) {
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
    let report, evidence;
    const caution = previous.status === '进行中' ? '上轮中断，务必先核对本关已领取状态。' : '';
    const previousNote = previous.note ? '上次观察：'+previous.note.slice(0,450)+'。更换失败的作业或阵容。' : '';
    try {
      report = await play('本轮只处理 '+t.label+'。'+t.route+'。'+caution+previousNote+
        '先确认目标关号、模式和账号完成状态。已完成就跳过。仅打一遍正式作战，普通关用相符作业、自动编队或按名册适配，剧情可免费跳过。结算/奖励/已完成标志须由实机核实。就此返回首页，勿领其他奖励。finish 的 note 必须从以下之一开始：首通已核、原已完成、理智不足、结晶不足、入口关闭、未完成，再写证据及失败作业号。'+spendRule,75,e=>{
        const labels = e.anchors.map(a=>a.label).join('').replace(/\s/g,'');
        if (/已完成模拟作战|获得物资|结算三星标志|磨难结算标志|行动结束/.test(labels)) evidence=e.preview;
      },t.stage || undefined);
    } catch (error) { signal.throwIfAborted(); report='未完成 '+error.message; }
    wallet = await homeWallet();
    // An interrupted successful battle may already have been credited on this run's first frame.
    if (previous.status === '进行中' && report.startsWith('原已完成') &&
        wallet[t.currency]-before[t.currency] === t.amount) report = '首通已核（中断后复核） '+report;
    const status = reconcileReward(t,report,before,wallet);
    await imageFile(t.id,'home',wallet.image);
    if (evidence) await imageFile(t.id,'result',evidence);
    const row = ledger.items[t.id] = {status,attempts,before,after:numbers(wallet),note:report,at:new Date().toISOString()};
    if (closed.has(status)) ledger.opened[t.chapter] = true;
    else if (status === '理智不足') ledger.sanityWait = row.nextAt = Date.now()+Math.max(10,t.ap||10)*6*minute;
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
