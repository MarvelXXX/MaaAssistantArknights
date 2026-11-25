import test from 'node:test';
import assert from 'node:assert/strict';
import {nextRewardGuide, reconcileReward, rewardEvidence, runRewardStage, selectRewardTarget, verifyWalletAccount} from '../lib/reward-queue.mjs';
import {watchBattlePause,watchTutorialDialog} from '../lib/maa.mjs';

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
