import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../lib/agent.mjs';
import { decide } from '../lib/model.mjs';
import { matchChapterRewards, matchRewards, matchSimulations } from '../lib/rewards.mjs';

test('兼容接口拒绝原生函数时，JSON规划仍能看到最新的章节查询及参数',async t=>{
  const config={url:'http://localhost/v1',model:'test',vision:false};
  const context={instruction:'查看苦难摇篮的公开首通奖励',recentSteps:[]};
  const action={type:'chapter_rewards',stage:'苦难摇篮'};
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    const body=JSON.parse(options.body);
    if(body.tools)return new Response(null,{status:400});
    assert.match(body.messages[0].content,/chapter_rewards\(stage\)/);
    return Response.json({choices:[{message:{content:JSON.stringify({intent:'inspect',goal:'查章节',note:'查表',action})}}]});
  });
  const chosen=await decide(config,context,{},AbortSignal.timeout(5000));
  assert.equal(config.toolsUnsupported,true);
  assert.deepEqual(validateDecision(chosen,{},true,false).action,action);
  assert.throws(()=>validateDecision({...chosen,action:{type:'chapter_rewards'}},{},true,false),/资料工具.*参数无效/);
});

test('章节首通按关卡ID去重，保留难度，排除过期、尚未开放和临时借用主线地图的活动', () => {
  const battle = {stageId:'base',code:'1-1',stageType:'MAIN',zoneId:'main_1',difficulty:'NORMAL',diamondOnceDrop:1};
  const alt = {...battle,stageId:'hard',difficulty:'FOUR_STAR'};
  const expired = {...battle,stageId:'old',stageType:'ACTIVITY'};
  const future = {...battle,stageId:'future'};
  const stageTable = {stages:{battle,alt,expired,future},stageValidInfo:{future:{startTs:11,endTs:-1}}};
  const zones = {main_1:{type:'MAINLINE',zoneNameSecond:'主章',zoneNameTitleCurrent:'01'}};
  const emptyActivity = {basicInfo:{},zoneToActivity:{}};
  const emptyArchive = {stageList:{},retroActList:{},zoneToRetro:{},stageValidInfo:{}};
  const main = matchChapterRewards('EP01', stageTable, zones, emptyArchive, emptyActivity, 10);
  assert.equal(main.chapter,'主章');
  assert.equal(main.firstClearOriginite,2);
  assert.deepEqual(main.modes.map(m=>[m.mode,m.codes]),[['普通',['1-1']],['突袭／遭遇',['1-1']]]);

  const live = {...battle,stageType:'ACTIVITY',zoneId:'live'};
  const stages = {stages:{live}};
  const activity = {basicInfo:{rerun:{name:'活动',startTime:0,endTime:20}},zoneToActivity:{live:'rerun'}};
  const copy = {...live,zoneId:'archive'};
  const archive = {stageList:{copy},zoneToRetro:{archive:'series'},retroActList:{series:{name:'活动',startTime:0}},stageValidInfo:{}};
  assert.equal(matchChapterRewards('活动',stages,{},archive,activity,10).firstClearOriginite,1);
  assert.equal(matchChapterRewards('活动',stages,{},emptyArchive,activity,20).found,false);
  const action = {type:'chapter_rewards', stage:'活动'};
  assert.deepEqual(validateDecision({intent:'inspect',goal:'核查章节',note:'查询',action},{},true,false).action,action);
});

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
