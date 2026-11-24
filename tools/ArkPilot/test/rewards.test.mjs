import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../lib/agent.mjs';
import { matchRewards, matchSimulations } from '../lib/rewards.mjs';

test('同编号保留不同难度的首通奖励，章节名片评价不参与计算', () => {
  const normal = {code:'16-6', name:'痛觉明灭', stageId:'main_16-05', difficulty:'NORMAL', diamondOnceDrop:1};
  const hard = {...normal, stageId:'main_16-05#s', difficulty:'SIX_STAR'};
  const stages = {normal, hard};
  const rows = matchRewards(' 16-6 ', stages);
  assert.deepEqual(rows.map(row => [row.difficulty, row.firstClearOriginite]), [['NORMAL',1],['SIX_STAR',1]]);
  assert.deepEqual(matchRewards('未知关卡', stages), []);
  const adverse = {...normal, stageId:'tough_14-01', code:'14-2', diffGroup:'TOUGH'};
  assert.equal(matchRewards('14-2', {adverse})[0].diffGroup, 'TOUGH');
  const action = {type:'stage_rewards',stage:'16-6'};
  assert.deepEqual(validateDecision({intent:'inspect',goal:'核查首通',note:'查询配置',action}, {}, true, false).action, action);
});

test('剿灭按歼灭数列出一次性合成玉，不计入周报酬', () => {
  const stage = {code:'伊比利亚', name:'积水潮窟 ', stageId:'camp_r_05', difficulty:'NORMAL', diamondOnceDrop:0};
  const tiers = [{killCnt:375, rewards:[{id:'4001',count:3000}]},
    {killCnt:400, rewards:[{id:'4003',count:600},{id:'30125',count:1}]}];
  const [row] = matchRewards('积水潮窟', {stage}, {camp_r_05:{breakLadders:tiers}});
  assert.equal(row.firstClearOriginite, 0);
  assert.deepEqual(row.firstKillOrundum, [{kills:400,amount:600}]);
});

test('被卡片遮住的干员名可以用悖论模拟关名反查', () => {
  const operators = [{id:'saga',name:'嵯峨'},{id:'other',name:'没有模拟的干员'}];
  const s = {charId:'saga',stageId:'mem_saga_1',name:'一心晦明',rewardItem:[{id:'4003',count:200}]};
  const expected = [{stageId:'mem_saga_1',name:'一心晦明',operator:'嵯峨',firstClearOrundum:200}];
  for (const query of ['嵯峨','一心晦明']) assert.deepEqual(matchSimulations(query,{s},operators),expected);
  assert.deepEqual(matchSimulations('没有模拟的干员',{s},operators),[]);
});
