import test from 'node:test';
import assert from 'node:assert/strict';
import {nextRewardGuide, reconcileReward, selectRewardTarget} from '../lib/reward-queue.mjs';
import {watchTutorialDialog} from '../lib/maa.mjs';

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

test('从实战记录和旧进度中跳过失败作业，保留按练度选择攻略的路线', () => {
  const target={id:'t',requires:[],guideId:'1001',retryGuideIds:['1002','1003']};
  const row={status:'未完成',note:'失败作业号：1002。',failedGuideIds:['1001']};
  assert.equal(nextRewardGuide(target), '1001');
  assert.equal(nextRewardGuide(target,row), '1003');
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
