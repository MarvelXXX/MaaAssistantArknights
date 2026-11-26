import test from 'node:test';
import assert from 'node:assert/strict';
import {dismissStoneRecovery, needsParadoxVisit, nextRewardGuide, readWalletWithRetry, reconcileReward, refreshSanityWait, renderProgress, rewardEvidence, rewardReceipt, rewardWalletContext, runRewardStage, selectRewardTarget, verifiedFirstDrop, verifyWalletAccount, visitParadoxDetail, waitForRewardManifest, waitForWalletModel} from '../lib/reward-queue.mjs';

test('等待自然理智期间更新清单可提前唤醒，不会一直等到理智回满',async()=>{
  const pauses=[];
  await waitForRewardManifest(new URL(import.meta.url),0,Date.now()+3600000,new AbortController().signal,
    async ms=>{pauses.push(ms);});
  assert.deepEqual(pauses,[10000]);
});

test('凭证兑换同时核对两项余额、扣券量与库存，不重复记作免费领取或首通',()=>{
  for (const lots of [1,95]) {
    const t={id:'exchange',label:'情报凭证',currency:'orundum',amount:100*lots,requires:[],intelExchange:{lots,tickets:1905,stock:864}};
    const before={prime:12,orundum:55},after={prime:12,orundum:55+t.amount};
    const note='兑换已核，情报凭证 1905→'+(1905-lots*20)+'，商品库存 864→'+(864-lots);
    assert.equal(reconcileReward(t,note,before,after),'兑换已核');
    assert.equal(reconcileReward(t,note,before,before),'余额待复核');
    assert.equal(reconcileReward(t,note,before,{...after,prime:11}),'余额下降');
    assert.equal(reconcileReward(t,note.replace('864','865'),before,after),'余额待复核');
    assert.equal(reconcileReward(t,note.replace('1905','1904'),before,after),'余额待复核');
    assert.equal(reconcileReward(t,'领取已核',before,after),'余额待复核');
    const ledger={items:{exchange:{status:'兑换已核',at:'2026-11-26T00:00:00Z',after,exchangeStock:true}}};
    assert.equal(selectRewardTarget([t],ledger,0),undefined);
    assert.equal(selectRewardTarget([{...t,revision:2}],{items:{exchange:{status:'余额待复核',review:true,revision:1}}},0).id,t.id);
    assert.match(renderProgress({targets:[t]},ledger),/首通 0 项、领取免费奖励 0 项、核实凭证兑换 1 项/);
  }
});
import {watchBattlePause,watchDaemonSelection,watchTutorialDialog} from '../lib/maa.mjs';

test('同关重试锚定当轮起点，恢复中断保留原始起点及最新余额', () => {
  const wallet = {prime:167, orundum:27078};
  const prior = '未完成，缺芯片，上次首页合成玉为 26878';
  const retry = rewardWalletContext(wallet,wallet,prior);
  assert.match(retry,/开始时首页实测余额为 167 源石、27078 合成玉/);
  assert.match(retry,/历史记录.*上次核查.*26878/);
  assert.doesNotMatch(retry,/恢复任务/);
  const resumed = rewardWalletContext(wallet,{prime:167,orundum:27278});
  assert.match(resumed,/开始时首页实测余额为 167 源石、27078 合成玉/);
  assert.match(resumed,/恢复任务时首页实测为 167 源石、27278 合成玉/);
  assert.doesNotMatch(resumed,/历史记录/);
});

test('余额读取遇到临时断连时重新截图，错误凭据、离开首页和主动停止立即返回',async()=>{
  const controller=new AbortController(), waits=[];
  const pause=async ms=>{waits.push(ms);};
  const wallet={prime:160,orundum:26278};
  const temporary=Object.assign(new Error('模型暂时不可用'),{code:'MODEL_TEMPORARY'});
  const unreadable=Object.assign(new Error('首页数字模糊'),{code:'WALLET_UNREADABLE'});
  const captures=[temporary,unreadable,wallet];
  const read=async()=>{const result=captures.shift(); if (result instanceof Error) throw result; return result;};
  assert.deepEqual(await readWalletWithRetry(read,controller.signal,()=>{},pause),wallet);
  assert.deepEqual(waits,[10000,1000]);
  for (const error of [Object.assign(new Error('HTTP 401'),{status:401}),Object.assign(new Error(),{code:'NOT_HOME'}),Object.assign(new Error(),{code:'STONE_RECOVERY'})]) {
    await assert.rejects(readWalletWithRetry(async()=>{throw error;},controller.signal,()=>{},pause),e=>e===error);
  }
  assert.equal(waits.length,2);
  let count=0;
  const offline=async()=>{count++;throw temporary;};
  await assert.rejects(readWalletWithRetry(offline,controller.signal,()=>{},pause),e=>e===temporary);
  assert.equal(count,3);
  assert.deepEqual(waits.slice(-2),[10000,30000]);
  await assert.rejects(readWalletWithRetry(offline,controller.signal,()=>{},async()=>controller.abort()),{name:'AbortError'});
  assert.equal(count,4);
});

test('后台清单在长时间模型断连后重新从首页核账，保留停止和身份校验',async()=>{
  const controller = new AbortController(), waits = [];
  const offline = Object.assign(new Error('模型断连'), {code:'MODEL_TEMPORARY'});
  const wallet = {prime:161,orundum:26678};
  let reads = 0;
  const recover = async () => { if (++reads <= 4) throw offline; return wallet; };
  const pause = async (ms, _, options) => { assert.equal(options.signal,controller.signal); waits.push(ms); };
  assert.equal(await waitForWalletModel(recover,controller.signal,()=>{},pause),wallet);
  assert.deepEqual(waits,[120000,300000,900000,900000]);
  for (const error of [new Error('UID 不符'), new Error('HTTP 401'), new Error('读数失败')]) {
    await assert.rejects(waitForWalletModel(async()=>{throw error;},controller.signal,()=>{},pause),e=>e===error);
  }
  assert.equal(waits.length,4);
  let cancelledReads = 0;
  await assert.rejects(waitForWalletModel(async()=>{cancelledReads++;throw offline;},controller.signal,()=>{},
    async()=>controller.abort()),{name:'AbortError'});
  assert.equal(cancelledReads,1);
});

test('重试记录按上次结算状态展示旧截图，并兼容缺少上次状态的存档',()=>{
  const manifest={targets:[{id:'stage',label:'SL-MO-1'}]};
  const row={status:'进行中',lastStatus:'未完成',at:'2026-11-26T00:34:00Z',after:{prime:153,orundum:23478}};
  const report=()=>renderProgress(manifest,{items:{stage:row}});
  assert.match(report(),/最近开始核查的目标为 SL-MO-1/);
  assert.ok(report().includes('[未完成](stage-home.jpg)'));
  delete row.lastStatus;
  assert.ok(report().includes('[上次核查](stage-home.jpg)'));
  delete row.at;
  assert.ok(!report().includes('stage-home.jpg'));
});

test('摆完挂机后仅对持续敞开的同一名干员面板交回控制', () => {
  const watch=watchDaemonSelection({opers:[{name:'星熊'}],groups:[{opers:[{name:'红'}]}]});
  const hud={label:'战斗防御点图标',source:'Maa'};
  const frame=(name,x=30)=>({width:1600,anchors:[hud,...[name,'攻击 540','防御 1160'].map(label=>({label,source:'OCR',box:[x,190,55,25]}))]});
  assert.equal(watch('Deploy',frame('星熊'),0),false);
  assert.equal(watch('SkillDaemon',frame('星熊',1300),5000),false);
  assert.equal(watch('SkillDaemon',frame('星熊'),10000),false);
  assert.equal(watch('SkillDaemon',frame('星熊'),16000),false);
  assert.equal(watch('SkillDaemon',{width:1600,anchors:[hud]},22000),false);
  assert.equal(watch('SkillDaemon',frame('星熊'),28000),false);
  assert.equal(watch('SkillDaemon',frame('星熊'),34000),true);
  assert.equal(watch('SkillDaemon',frame('红'),40000),false);
  assert.equal(watch('SkillDaemon',frame('红'),60000),false);
  assert.equal(watch('SkillDaemon',{width:1600,anchors:[]},66000),false);
  assert.equal(watch('SkillDaemon',frame('红'),70000),false);
});

test('教学结算过渡中断后仅凭同关三星、首次掉落及两种货币的准确差额入账', async () => {
  const target={stage:'act27side_tr02',label:'火山旅梦 SL-TR-2 普通 跟着我拍拍手',currency:'prime',amount:1};
  const before={prime:136,orundum:17978}, after={prime:137,orundum:17978};
  const anchors=['SL-TR-2','跟着我拍拍手','首次掉落'].map(label=>({label,source:'OCR'}));
  anchors.push({label:'结算三星标志',source:'Maa'});
  assert.equal(await verifiedFirstDrop(target,before,after,anchors),true);
  for (const missing of anchors) {
    assert.equal(await verifiedFirstDrop(target,before,after,anchors.filter(a=>a!==missing)),false);
  }
  assert.equal(await verifiedFirstDrop({...target,stage:'act27side_tr01'},before,after,anchors),false);
  assert.equal(await verifiedFirstDrop({...target,label:'火山旅梦 SL-TR-2 突袭 跟着我拍拍手'},before,after,anchors),false);
  assert.equal(await verifiedFirstDrop(target,before,{...after,prime:138},anchors),false);
  assert.equal(await verifiedFirstDrop(target,before,{...after,orundum:17778},anchors),false);
  const evidence=rewardEvidence(target.stage);
  evidence.observe({type:'frame',preview:'early',anchors:[{label:'行动结束'}]});
  evidence.observe({type:'frame',preview:'complete',anchors});
  assert.equal(evidence.best.preview,'complete');
});

test('突袭首次掉落只由同关突袭结算徽记、首次掉落及对应余额核销', async () => {
  const target={stage:'act15d0_ex02#f#',label:'孤岛风云 MB-EX-2 突袭／遭遇 三面楚歌',currency:'prime',amount:1};
  const before={prime:159,orundum:25878}, after={prime:160,orundum:25878};
  const words=['MB-EX-2','三面楚歌','首次掉落'].map(label=>({source:'OCR',label}));
  const badge={source:'Maa',label:'磨难结算标志'};
  const anchors=[...words,badge];
  assert.equal((await rewardReceipt(target,before,after,anchors)).status,'首通已核');
  assert.equal(await rewardReceipt(target,before,after,[...words,{...badge,label:'结算三星标志'}]),undefined);
  assert.equal(await rewardReceipt({...target,stage:'act15d0_ex02'},before,after,anchors),undefined);
  assert.equal(await rewardReceipt(target,before,after,anchors.filter(a=>a.label!=='首次掉落')),undefined);
  assert.equal(await rewardReceipt(target,before,{...after,orundum:26078},anchors),undefined);
  const evidence=rewardEvidence(target.stage);
  evidence.observe({type:'frame',preview:'first',anchors:[badge]});
  evidence.observe({type:'frame',preview:'receipt',anchors});
  assert.equal(evidence.best.preview,'receipt');
});

test('无名悖论首通结算只在精确到账时回看详情，看到开始按钮便停止输入',async()=>{
  const target={stage:'mem_ansel_1',label:'安赛尔「冷静的支援者」',amount:200,currency:'orundum'};
  const row={status:'余额待复核',before:{prime:160,orundum:26278},after:{prime:160,orundum:26478}};
  const stars={source:'Maa',label:'结算三星标志'}, drop={source:'OCR',label:'首次掉落'};
  assert.ok(needsParadoxVisit(target,row,[stars,drop]));
  for (const anchors of [[stars],[drop],[]]) assert.ok(!needsParadoxVisit(target,row,anchors));
  for (const after of [row.before,{prime:161,orundum:26478},{prime:160,orundum:26678}])
    assert.ok(!needsParadoxVisit(target,{...row,after},[stars,drop]));
  assert.ok(!needsParadoxVisit(target,{...row,status:'首通已核'},[stars,drop]));
  const start={source:'Maa',label:'悖论模拟开始按钮'};
  const ocr=label=>({source:'OCR',label});
  const anchors=[start,ocr('悖论模拟'),ocr('冷静的支援者'),ocr('已完成模拟作战')];
  const inspect=screen=>visitParadoxDetail(async({emit,allowNative,signal})=>{
    assert.equal(allowNative,false);
    emit({type:'frame',anchors:[ocr('干员')],preview:'home'});
    signal.throwIfAborted();
    emit({type:'frame',anchors:screen,preview:'proof'});
    assert.ok(signal.aborted);
    signal.throwIfAborted();
  },target,'冷静的支援者',new AbortController().signal,()=>{});
  assert.equal(await inspect(anchors),'proof');
  assert.equal(await inspect(anchors.filter(a=>a.label!=='冷静的支援者')),undefined);
  assert.equal(await inspect(anchors.filter(a=>a.label!=='已完成模拟作战')),undefined);
  assert.equal(await inspect([...anchors,ocr('公开招募'),ocr('采购中心')]),undefined);
  assert.equal(await inspect([{source:'Maa',label:'源石恢复提示'}]),undefined);
  const arrive=async({emit,signal})=>{
    emit({type:'frame',preview:'opening',anchors:[start]});
    signal.throwIfAborted();
  };
  const controller=new AbortController();
  let captures=0, diagnostic;
  const stable=async()=>({preview:'complete',anchors:++captures===2 ? anchors : [start]});
  assert.equal(await visitParadoxDetail(arrive,target,'冷静的支援者',controller.signal,()=>{},stable),'complete');
  assert.equal(captures,2);
  assert.equal(await visitParadoxDetail(arrive,target,'另一关',controller.signal,()=>{},stable,p=>{diagnostic=p;}),undefined);
  assert.equal(diagnostic,'complete');
});

test('理智或模型阻塞后仍可载入唯一作业，真实胜负继续以余额和结算为准',()=>{
  const target={stage:'act25side_04',guideId:'23093',currency:'prime',amount:1};
  for (const status of ['理智不足','模型待重试','结晶不足']) {
    assert.equal(nextRewardGuide(target,{status,note:status,offeredGuideIds:['23093']}),'23093');
    assert.equal(nextRewardGuide(target,{status:'进行中',lastStatus:status,note:status}),'23093');
    assert.equal(nextRewardGuide(target,{status,note:status,failedGuideIds:['23093']}),undefined);
  }
  const before={prime:160,orundum:26678};
  assert.equal(reconcileReward(target,'模型待重试 断连',before,before),'模型待重试');
  assert.equal(reconcileReward(target,'模型待重试 断连',before,{...before,prime:161}),'余额待复核');
});

test('悖论总结中断后用本关已完成的截图与独立余额核账', async () => {
  const target={stage:'mem_fang_1',currency:'orundum',amount:200};
  const before={prime:157,orundum:24278}, after={prime:157,orundum:24478};
  const anchors=['悖论模拟','愉快合作','《 ． 已完成模拟作战'].map(label=>({source:'OCR',label}));
  anchors.push({source:'Maa',label:'悖论模拟开始按钮'});
  assert.equal((await rewardReceipt(target,before,after,anchors)).status,'首通已核');
  for (const missing of anchors) {
    assert.equal(await rewardReceipt(target,before,after,anchors.filter(a=>a!==missing)),undefined);
  }
  assert.equal(await rewardReceipt({...target,stage:'mem_falco_1'},before,after,anchors),undefined);
  assert.equal(await rewardReceipt(target,before,{...after,prime:158},anchors),undefined);
  assert.equal(await rewardReceipt(target,before,{...after,orundum:24678},anchors),undefined);
  assert.equal(await rewardReceipt(target,before,before,anchors),undefined);
  const evidence=rewardEvidence(target.stage,false,'愉快合作');
  evidence.observe({type:'frame',preview:'battle',anchors:[{label:'战斗防御点图标'}]});
  evidence.observe({type:'frame',preview:'stars',anchors:[{label:'结算三星标志'}]});
  evidence.observe({type:'frame',preview:'cleared',anchors});
  evidence.observe({type:'frame',preview:'overlay',anchors:[...anchors,{label:'公开招募'},{label:'采购中心'}]});
  assert.equal(evidence.best.preview,'cleared');
  assert.equal(evidence.best.kind,'result');
});

test('悖论凭证优先保留无遮挡结算，OCR漏读时仅保存战后关卡页', () => {
  const first = rewardEvidence('mem_ifrit_1');
  const frame = (preview, ...labels) => ({type:'frame',preview,anchors:labels.map(label=>({label}))});
  const detail = frame('detail','悖论模拟开始按钮');
  first.observe(detail);
  assert.equal(first.best,undefined);
  first.observe(frame('battle','战斗防御点图标'));
  first.observe(detail);
  assert.equal(first.best.kind,'stage');
  first.observe(frame('menu','已完成模拟作战','公开招募','采购中心'));
  assert.equal(first.best.preview,'detail');
  first.observe(frame('done','已完成模拟作战'));
  assert.equal(first.best.preview,'done');
  first.observe(frame('stars','结算三星标志'));
  first.observe(frame('fading','行动结束'));
  first.observe(detail);
  assert.equal(first.best.preview,'stars');
  assert.equal(first.best.kind,'result');
  const quick = rewardEvidence('mem_chen_1');
  quick.observe({type:'applied',action:{type:'maa',task:'ParadoxCopilot'}});
  quick.observe(detail);
  assert.equal(quick.best.kind,'stage');
  const other = rewardEvidence('main_00-01');
  other.observe(frame('battle','战斗防御点图标'));
  other.observe(detail);
  assert.equal(other.best,undefined);
});

test('首通须有实机结论和对应余额变化，已通关不重复记账', () => {
  const t = {amount:200,currency:'orundum'};
  const before = {prime:100,orundum:10000};
  const after = {...before,orundum:10200};
  assert.equal(reconcileReward(t,'首通已核 实机已完成',before,after),'首通已核');
  assert.equal(reconcileReward(t,'首通已核 实机已完成',before,before),'余额待复核');
  assert.equal(reconcileReward(t,'未完成',before,after),'余额待复核');
  assert.equal(reconcileReward(t,'原已完成',before,before),'原已完成');
  assert.equal(reconcileReward(t,'首通已核',before,{...after,prime:99}),'余额下降');
});

test('免费奖励按实机领取报告和两种余额核对，活跃度或附带物资不计作货币', () => {
  const target = {claimAvailable:true,currency:'orundum',amount:1};
  const before = {prime:148,orundum:21378};
  const daily = {...before,orundum:before.orundum+100};
  const mail = {...before,prime:before.prime+1};
  assert.equal(reconcileReward(target,'领取已核 日常合成玉到账',before,daily),'领取已核');
  assert.equal(reconcileReward(target,'首通已核 邮件源石到账',before,mail),'领取已核');
  assert.equal(reconcileReward(target,'领取已核',before,before),'余额待复核');
  assert.equal(reconcileReward(target,'原已完成',before,mail),'余额待复核');
  assert.equal(reconcileReward(target,'未完成 仅领取活跃度和龙门币',before,before),'未完成');
  assert.equal(reconcileReward(target,'领取已核',before,{...daily,prime:147}),'余额下降');
});

test('复核免费领取需同一张获得物资画面的币种、对应数量和余额增量全部吻合', async () => {
  const target = {claimAvailable:true,currency:'orundum'};
  const before = {prime:148,orundum:21578}, after = {...before,orundum:21678};
  const ocr = (label,box) => ({source:'OCR',label,box});
  const header = ocr('获得物资',[665,161,109,28]);
  const currency = ocr('合成玉',[216,388,71,23]);
  const quantity = ocr('100',[254,329,43,22]);
  const money = ocr('龙门币',[403,388,71,23]);
  const foreign = ocr('1,000',[426,329,58,21]);
  const anchors = [header,currency,quantity,money,foreign];
  assert.equal((await rewardReceipt(target,before,after,anchors)).status,'领取已核');
  assert.equal(await rewardReceipt(target,before,{...after,prime:149},anchors),undefined);
  assert.equal(await rewardReceipt(target,before,{...before,orundum:22578},anchors),undefined);
  assert.equal(await rewardReceipt(target,before,after,[currency,quantity]),undefined);
  assert.equal(await rewardReceipt(target,before,before,anchors),undefined);
  const evidence = rewardEvidence(undefined,true);
  evidence.observe({type:'frame',preview:'materials',anchors:[header,money,foreign]});
  evidence.observe({type:'frame',preview:'currency',anchors});
  assert.equal(evidence.best.preview,'currency');
});

test('理智和结晶不足时继续独立目标，保留待复核和前置关系', () => {
  const targets=[
    {id:'a',ap:10,requires:[]}, {id:'b',ap:0,requires:['a']},
    {id:'c',chapter:'甲',crystal:true,requires:[]}, {id:'d',requires:[]},
  ];
  const ledger={items:{},opened:{},sanityWait:20,crystalWait:30};
  assert.equal(selectRewardTarget(targets,ledger,10).id,'d');
  ledger.items.d={review:true};
  assert.equal(selectRewardTarget(targets,ledger,10),undefined);
  ledger.items.a={status:'原已完成'};
  assert.equal(selectRewardTarget(targets,ledger,10).id,'b');
});

test('恢复时先核对中断项，避免把另一关的奖励记到旧账上', () => {
  const targets=[{id:'new',requires:[]},{id:'interrupted',requires:[]}];
  assert.equal(selectRewardTarget(targets,{items:{interrupted:{status:'进行中'}},opened:{}},0).id,'interrupted');
});

test('25 理智的剿灭等待期间可打 9 理智的关卡，恢复后可重试剿灭', () => {
  const expensive={id:'camp',ap:25,requires:[]};
  const cheap={id:'story',ap:9,requires:[]};
  const ledger={items:{},opened:{},sanityCost:25,sanityWait:50};
  assert.equal(selectRewardTarget([expensive,cheap],ledger,10),cheap);
  assert.equal(selectRewardTarget([expensive,cheap],ledger,50),expensive);
});

test('首页理智优先分配给可开战的目标，没有便宜关卡时保留补给核查', () => {
  const main = {id:'zt8',ap:21,requires:[]};
  const locked = {id:'story',ap:0,requires:['zt8']};
  const cheap = {id:'mt3',ap:9,requires:[]};
  const free = {id:'paradox',ap:0,requires:[]};
  const targets = [main,locked,cheap,free];
  const ledger = {items:{},opened:{}};
  assert.equal(selectRewardTarget(targets,ledger,0,13),cheap);
  assert.equal(selectRewardTarget(targets,ledger,0,0),free);
  assert.equal(selectRewardTarget(targets,ledger,0,21),main);
  assert.equal(selectRewardTarget(targets,ledger,0,undefined),main);
  assert.equal(selectRewardTarget([main,locked,cheap],ledger,0,2),main);
  ledger.items.zt8 = {status:'进行中'};
  assert.equal(selectRewardTarget(targets,ledger,0,0),main);
});

test('打完低耗关后按首页理智重新排程，重复读数保留恢复时刻', () => {
  const minute=60000, now=100*minute;
  const main={id:'zt',ap:21,requires:[]}, cheap={id:'le',ap:9,requires:[]}, free={id:'mo',ap:0,requires:[]};
  const targets=[main,cheap,free];
  const ledger={items:{
    zt:{status:'理智不足',nextAt:now+15*minute},
    le:{status:'理智不足',nextAt:now+minute},
    mo:{status:'未完成',nextAt:now+4*minute},
  },opened:{},sanityCost:21,sanityWait:now+15*minute};
  refreshSanityWait(targets,ledger,undefined,now);
  assert.equal(ledger.sanityWait,now+15*minute);
  refreshSanityWait(targets,ledger,7,now);
  assert.equal(ledger.items.zt.nextAt,now+84*minute);
  assert.equal(ledger.items.le.nextAt,now+12*minute);
  assert.equal(ledger.items.mo.nextAt,now+4*minute);
  assert.equal(ledger.sanityCost,9);
  assert.equal(ledger.sanityWait,ledger.items.le.nextAt);
  refreshSanityWait(targets,ledger,7,now+minute);
  assert.equal(ledger.sanityWait,now+12*minute);
  assert.equal(selectRewardTarget(targets,ledger,now+4*minute),free);
  refreshSanityWait(targets,ledger,9,now+12*minute);
  assert.equal(selectRewardTarget(targets,ledger,now+12*minute),cheap);
  assert.equal(ledger.sanityCost,21);
  refreshSanityWait(targets,ledger,25,now+13*minute);
  assert.equal(selectRewardTarget(targets,ledger,now+13*minute),main);
  assert.equal(ledger.sanityWait,undefined);
});

test('登录认证失效会中断在途作业，即使工作进程随后报普通失败',async()=>{
  const options={signal:AbortSignal.timeout(3000),emit:()=>{}};
  await assert.rejects(runRewardStage(async({emit,signal})=>{
    emit({type:'frame',anchors:[{label:'登录认证已失效 ， 请重新登录'}]});
    assert.equal(signal.aborted,true);
    throw new Error('task chain incomplete');
  },options),{code:'GAME_SESSION_EXPIRED'});
  await runRewardStage(async({emit,signal})=>{
    emit({type:'frame',anchors:[{label:'当日登录奖励'}]});
    assert.equal(signal.aborted,false);
  },options);
});

test('付费理智弹窗中断当前作业并保留自然理智读数，库存药剂可继续', async () => {
  const options={ap:21,signal:AbortSignal.timeout(3000),emit:()=>{}};
  const run=anchors=>runRewardStage(async({emit,signal})=>{
    emit({type:'decision',note:'当前自然理智为 17/210，关卡需 21。'});
    emit({type:'frame',anchors});
    signal.throwIfAborted();
  },options);
  for (const anchors of [
    [{source:'Maa',label:'源石恢复提示'}],
    [{source:'OCR',label:'是否花费 1 至纯源石兑换'},{source:'OCR',label:'理智？'}],
  ]) {
    await assert.rejects(run(anchors),e=>e.code==='STONE_RECOVERY' && e.message.startsWith('理智不足，当前理智 17，关卡需 21'));
  }
  await run([{source:'Maa',label:'理智药恢复提示'},{source:'OCR',label:'使用至纯源石恢复'}]);
  await run([{source:'OCR',label:'是否花费600合成玉进行寻访'}]);
});

test('取消源石恢复只发一次返回键，等待弹窗与过渡画面消失后才继续导航', async () => {
  const prompt=[{source:'Maa',label:'源石恢复提示'}], detail=[{source:'OCR',label:'开始行动'}];
  const frames=[prompt,[],detail,prompt,detail];
  const inputs=[];
  const device={input:async action=>inputs.push(action),capture:async()=>({anchors:frames.shift()})};
  const run=()=>dismissStoneRecovery(device,AbortSignal.timeout(3000),async x=>x,async()=>{});
  await assert.rejects(run(),/核实源石恢复弹窗关闭/);
  frames.push(prompt,[],detail,detail);
  await run();
  assert.deepEqual(inputs,[{type:'back'},{type:'back'}]);
  assert.equal(frames.length,0);
});

test('从实战记录和旧进度中跳过失败作业，保留按练度选择攻略的路线', () => {
  const target={id:'t',requires:[],guideId:'1001',retryGuideIds:['1002','1003']};
  const row={status:'未完成',note:'失败作业号：1002。',failedGuideIds:['1001']};
  assert.equal(nextRewardGuide(target), '1001');
  assert.equal(nextRewardGuide(target,row), '1003');
  const mismatch={status:'未完成',note:'芬的技能低于要求，本轮未开战。',offeredGuideIds:['1001']};
  assert.equal(nextRewardGuide(target,mismatch),'1002');
  mismatch.status='理智不足';
  assert.equal(nextRewardGuide(target,mismatch),'1001');
  assert.equal(nextRewardGuide({...target,retryGuideIds:[]},row), undefined);
  assert.equal(nextRewardGuide({...target,plan:{}},row), undefined);
});

test('零理智关在实战失败后立即使用不同作业，其他等待仍然有效', () => {
  const stage={id:'mem_glider_1',ap:0,requires:[],guideId:'37649',retryGuideIds:['21282']};
  const row={status:'未完成',nextAt:100,failedGuideIds:['37649'],offeredGuideIds:['37649']};
  const ledger={items:{[stage.id]:row},opened:{}};
  assert.equal(selectRewardTarget([stage],ledger,10),stage);
  assert.equal(nextRewardGuide(stage,row),'21282');
  assert.equal(selectRewardTarget([{...stage,ap:9}],ledger,10),undefined);
  assert.equal(selectRewardTarget([{...stage,requires:['locked']}],ledger,10),undefined);
  assert.equal(selectRewardTarget([{...stage,plan:{}}],ledger,10),undefined);
  row.failedGuideIds=[];
  assert.equal(selectRewardTarget([stage],ledger,10),undefined);
  row.note='失败作业号：37649';
  assert.equal(selectRewardTarget([stage],ledger,10),stage);
  row.offeredGuideIds.push('21282');
  assert.equal(selectRewardTarget([stage],ledger,10),undefined);
});

test('待复核的战败只在增加可用新作业时恢复，到账异常持续保留', () => {
  const t={id:'t',requires:[],guideId:'101',retryGuideIds:['102']};
  const row={review:true,status:'未完成',note:'失败作业号：101',offeredGuideIds:['101','102']};
  const ledger={items:{t:row},opened:{}};
  assert.equal(selectRewardTarget([t],ledger,10),undefined);
  t.retryGuideIds.push('103');
  assert.equal(selectRewardTarget([t],ledger,10),t);
  row.status='余额待复核';
  assert.equal(selectRewardTarget([t],ledger,10),undefined);
  row.status='首通已核';
  assert.equal(selectRewardTarget([t],ledger,10),undefined);
});

test('固定队教学只在对白与击杀计数持续停滞时交回当前战斗', () => {
  const stalled=watchTutorialDialog();
  const frame=n=>[{label:n+' / 9'}];
  assert.equal(stalled('BattleAvatarDialog',frame(1),0),false);
  assert.equal(stalled('BattleAvatarDialog',frame(2),40000),false);
  assert.equal(stalled('BattleAvatarDialog',frame(2),84999),false);
  assert.equal(stalled('BattleAvatarDialog',frame(2),85000),true);
  assert.equal(stalled('UseSkill',frame(2),90000),false);
  assert.equal(stalled('BattleAvatarDialog',frame(2),95000),false);
  assert.equal(stalled('BattleAvatarDialog',[],160000),false);
});

test('战斗长期暂停时只恢复一次，再次停滞时交回视觉',()=>{
  const hud={label:'战斗防御点图标',source:'Maa'};
  const text={label:'“ 暂停中一',source:'OCR',box:[723,464,154,33]};
  const frame=(...anchors)=>({width:1600,height:900,anchors});
  const watch=watchBattlePause();
  assert.equal(watch(frame(text),0),undefined);
  assert.equal(watch(frame(hud,{...text,box:[0,10,154,33]}),30000),undefined);
  assert.equal(watch(frame(hud,text),40000),undefined);
  assert.equal(watch(frame(hud,text),54999),undefined);
  assert.equal(watch(frame(hud,text),55000),'resume');
  assert.equal(watch(frame(hud,text),60000),undefined);
  assert.equal(watch(frame(hud,text),70000),'stalled');
  assert.equal(watch(frame(hud),80000),undefined);
  assert.equal(watch(frame(hud,text),120000),undefined);
});

test('更正作业后可提前重试一次，余额待核和已完成均不能重开', () => {
  const t={id:'t',requires:[],revision:2};
  const row={status:'未完成',revision:1,nextAt:100,review:true};
  const ledger={items:{t:row},opened:{}};
  assert.equal(selectRewardTarget([t],ledger,10),t);
  row.revision=2;
  assert.equal(selectRewardTarget([t],ledger,10),undefined);
  t.revision=3;
  row.status='入口关闭';
  assert.equal(selectRewardTarget([t],ledger,10),t);
  row.revision=3;
  assert.equal(selectRewardTarget([t],ledger,10),undefined);
  t.revision=4;
  for (const status of ['余额待复核','余额下降','首通已核','原已完成']) {
    row.status=status;
    assert.equal(selectRewardTarget([t],ledger,10),undefined);
  }
});

test('UID 有分歧时只读新帧，须连续两次匹配才能继续', async () => {
  const read=values=>async()=>({uid:values.shift()});
  assert.equal((await verifyWalletAccount(read(['123456']),'123456')).uid,'123456');
  assert.equal((await verifyWalletAccount(read(['123458','123456','123456']),'123456')).uid,'123456');
  await assert.rejects(verifyWalletAccount(read(['123458','123458']),'123456'),/UID/);
  await assert.rejects(verifyWalletAccount(read(['123458','123456','123458']),'123456'),/UID/);
});
