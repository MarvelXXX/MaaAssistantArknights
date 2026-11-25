import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileReward, selectRewardTarget} from '../lib/reward-queue.mjs';

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
