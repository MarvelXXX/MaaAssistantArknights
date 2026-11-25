import test from 'node:test';
import assert from 'node:assert/strict';
import {dismissStoneRecovery, nextRewardGuide, reconcileReward, rewardEvidence, rewardReceipt, runRewardStage, selectRewardTarget, verifiedFirstDrop, verifyWalletAccount} from '../lib/reward-queue.mjs';
import {watchBattlePause,watchDaemonSelection,watchTutorialDialog} from '../lib/maa.mjs';

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
