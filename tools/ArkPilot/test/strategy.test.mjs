import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PNG } from 'pngjs';
import { adaptGuide, assess, normalizeRoster, rosterFit } from '../lib/roster.mjs';
import { roguelikePlacements } from '../lib/guides.mjs';
import { searchWeb } from '../lib/research.mjs';
import { decide } from '../lib/model.mjs';
import { runAgent } from '../lib/agent.mjs';
import { createServer } from '../server.mjs';
import { mergeRosterScan } from '../public/guides.js';

const author = {stage_name:'main_01-07',opers:[{name:'能天使',skill:1,requirements:{elite:1,level:40}}],
  groups:[{name:'回费位',opers:[{name:'芬',skill:1},{name:'讯使',skill:1}]}],actions:[
    {type:'Deploy',name:'回费位',direction:'Right',location:[4,1]},
    {type:'Deploy',name:'能天使',direction:'Down',location:[2,1]},
    {type:'Retreat',name:'能天使',kills:20}]};
const box = {operators:[{name:'能天使',owned:false},{name:'克洛丝',elite:1,level:55,skill_level:7,skill_levels:[7]},{name:'讯使',elite:1,level:50}]};
const proposal = {status:'ready',reason:'采用同为速射手的克洛丝和组内先锋；验证右侧射程覆盖。',picks:[
  {slot:'能天使',id:'char_124_kroos',basedOn:'能天使',skill:1},
  {slot:'回费位',id:'char_198_blackd',basedOn:'讯使',skill:1}],edits:[{step:2,location:[3,1],direction:'Right',costs:12}]};

test('局部扫描更新等级、保留未扫到的干员和手填技能，完整扫描替换名单',()=>{
  const old={complete:true,operators:[{id:'typhon',owned:true,level:80},{id:'durin',owned:true,level:1,skill_level:1}]};
  const seen=[{id:'durin',owned:true,level:30},{id:'new',owned:true,level:20}];
  const partial=mergeRosterScan(old,{complete:false,operators:seen});
  assert.equal(partial.complete,false);
  assert.deepEqual(partial.operators,[{...old.operators[1],level:30},seen[1],old.operators[0]]);
  assert.deepEqual(mergeRosterScan(old,partial),partial);
  assert.deepEqual(mergeRosterScan(old,{complete:true,operators:seen}).operators,partial.operators.slice(0,2));
  assert.deepEqual(mergeRosterScan(undefined,{complete:false,operators:seen}).operators,seen);
  assert.equal(old.operators[1].level,1);
});

test('名册区分未持有、未知、技能未解锁、专精未知与已记录的专精',async()=>{
  const roster = await normalizeRoster(box);
  const status = c => assess({opers:[c]},roster)[0].choices[0].status;
  assert.equal(status({name:'能天使'}),'未持有');
  assert.equal(status({name:'芬'}),'尚未识别');
  assert.equal(status({name:'克洛丝',skill:2}),'练度或技能不足');
  const master = {name:'能天使',skill:3,requirements:{skill_level:9}};
  const stats = {name:'能天使',elite:2,level:70,mainSkillLevel:7};
  const check = async data => assess({opers:[master]},await normalizeRoster({own_opers:[data]}))[0].choices[0].status;
  assert.equal(await check(stats),'练度资料待补充');
  assert.equal(await check({...stats,skills:[{level:0},{level:0},{level:2}]}),'持有且满足已知要求');
  roster.complete = true; assert.equal(status({name:'芬'}),'未持有');
});

test('单个位置持有情况缺失时由 Maa 核对并可借助战，多个缺位和练度问题仍须适配',async()=>{
  const roster=await normalizeRoster(box);
  const fit=(names,group=false)=>rosterFit(group ? {groups:[{name:'狙击',opers:names}]} : {opers:names},roster);
  assert.equal(rosterFit(author,roster).supportSlot,'能天使');
  assert.equal(fit([{name:'能天使'}],true).supportSlot,'狙击');
  assert.equal(fit([{name:'能天使'},{name:'芬'}],true).supportSlot,'狙击');
  assert.equal(fit([{name:'能天使'},{name:'克洛丝'}],true).supportSlot,undefined);
  assert.equal(fit([{name:'能天使'},{name:'克洛丝',skill:2}],true).supportSlot,undefined);
  assert.equal(fit([{name:'克洛丝',skill:2}]).supportSlot,undefined);
  roster.complete=true;
  assert.equal(fit([{name:'能天使'},{name:'芬'}]).supportSlot,undefined);
});

test('适配改写真正的编队、组、部署和撤退，且保护原作业、地形和召唤依赖',async()=>{
  const roster = await normalizeRoster(box);
  const adapt = (plan,p) => adaptGuide(plan,roster,'',async()=>p);
  const {plan} = await adapt(author,proposal);
  assert.equal(plan.opers[0].name,'克洛丝');
  assert.equal(plan.groups[0].opers[0].name,'讯使');
  assert.equal(plan.actions[0].name,'回费位');
  assert.deepEqual(plan.actions[1],{type:'Deploy',name:'克洛丝',direction:'Right',location:[3,1],costs:12});
  assert.equal(plan.actions[2].name,'克洛丝');
  assert.equal(author.actions[2].name,'能天使');
  await assert.rejects(adapt(author,{...proposal,edits:[{step:2,location:[4,1]}]}),/地形/);
  await assert.rejects(adapt(author,{...proposal,edits:[{step:1,kills:10}]}),/开局击杀/);
  await assert.rejects(adapt(author,{...proposal,picks:[{...proposal.picks[0],skill:3},proposal.picks[1]]}),/练度/);
  const untrained = await normalizeRoster({operators:[...box.operators.slice(0,1),{name:'克洛丝',level:1,elite:0},box.operators[2]]});
  await assert.rejects(adaptGuide(author,untrained,'',async()=>proposal),/练度/);
  await assert.rejects(adapt({...author,actions:[...author.actions,{type:'Deploy',name:'“弦惊”',location:[4,1],direction:'Right'}]},proposal),/召唤物/);
  assert.equal((await adapt(author,{status:'blocked',reason:'缺少核心机制'})).ready,false);
});

test('实用工具以函数调用发送，将取帧结果作为工具回复交给下一轮判断',async t=>{
  const requests = [];
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    requests.push(JSON.parse(options.body));
    const message = requests.length === 1 ? {tool_calls:[{type:'function',function:{name:'analyze_video',
      arguments:JSON.stringify({bv:'BV1QY411L7H2',part:1,start:15,end:30})}}]} :
      {content:JSON.stringify({intent:'inspect',goal:'看视频',note:'已读取',action:{type:'finish'}})};
    return Response.json({choices:[{message}]});
  });
  const cfg={provider:'api',apiOptIn:true,url:'http://localhost/v1',model:'test',vision:true},ctx={instruction:'看看视频',recentSteps:[]};
  const step=await decide(cfg,ctx,{},AbortSignal.timeout(5000));
  assert.equal(step.action.type,'analyze_video');
  assert.ok(requests[0].tools.some(t=>t.function.name==='analyze_video'));
  ctx.recentSteps.push({turn:1,action:step.action,result:{notes:'15.9 秒：开局'}});
  await decide(cfg,ctx,{},AbortSignal.timeout(5000));
  assert.equal(requests[1].messages.at(-1).role,'tool');
  assert.match(requests[1].messages.at(-1).content,/15.9/);
});

test('更换核心干员技能时仍保留对其专属召唤物的依赖检查',async()=>{
  const roster = await normalizeRoster({operators:[{name:'令',elite:2,level:80}]});
  const plan = {stage_name:'1-7',opers:[{name:'令',skill:3}],actions:[
    {type:'Deploy',name:'令',location:[2,1],direction:'Left'},{type:'Skill',name:'“弦惊”'}]};
  await assert.rejects(adaptGuide(plan,roster,'',async()=>({status:'ready',reason:'改用一技能',edits:[],
    picks:[{slot:'令',id:'char_2023_ling',basedOn:'令',skill:1}]})),/召唤物/);
});

test('在线搜索把关卡作者引用的 BV 作为独立来源，保留可用来源及失败通道',async t=>{
  t.mock.method(globalThis,'fetch',async input=>{
    const url = new URL(input);
    if (url.hostname === 'prts.maa.plus') return Response.json({status_code:200,data:{data:[{id:55,content:JSON.stringify({stage_name:'main_01-07',doc:{title:'低配',details:'BV1QY411L7H2'}})}]}});
    if (url.hostname === 'prts.wiki') return Response.json({query:{search:[{title:'1-7',snippet:'<span>暴君</span>'}]}});
    if (url.hostname === 'api.bilibili.com') return new Response('',{status:412});
    return new Response('<rss><item><title>明日方舟低配</title><link>https://example.org/guide</link><description>明日方舟</description></item></rss>');
  });
  const result = await searchWeb('1-7 视频攻略',null,AbortSignal.timeout(3000));
  assert.ok(result.results.some(r=>r.bv==='BV1QY411L7H2'));
  assert.ok(result.results.some(r=>r.id==='55'));
  assert.ok(result.results.some(r=>r.snippet==='暴君'));
  assert.deepEqual(result.unavailable,['B 站视频搜索']);
});

async function listen(server,t) {
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>{server.closeAllConnections();server.close();});
  return 'http://127.0.0.1:'+server.address().port;
}
test('要求生成替补作业时不能把文字承诺当作完成，校验失败可见',async()=>{
  const simulate=async instruction=>{
    const events=[];
    await runAgent({config:{},device:null,readOnly:true,signal:AbortSignal.timeout(5000),limit:2,instruction,history:[],
      guidance:{roster:box,plan:author},emit:e=>events.push(e),
      plan:async()=>({intent:'inspect',goal:'核对',note:'已生成',action:{type:'finish'}}),
      lookupGuide:async()=>({ready:false,reason:'名册中缺少可部署人选'})});
    return events;
  };
  const attempted=await simulate('只用我的名册生成可执行替补作业。');
  assert.equal(attempted.find(e=>e.type==='decision').action.type,'adapt_guide');
  assert.equal(attempted.at(-1).outcome,'ask'); assert.match(attempted.at(-1).note,/缺少/);
  assert.equal((await simulate('请解释替补作业，不要生成作业。')).some(e=>e.type==='decision'),false);
});
test('同条指令把替补方案和自动编队传给 Maa；仅查攻略在无设备时可适配',async t=>{
  const decision = a => ({intent:'operate',goal:'按我的干员适配',note:'核对编队',action:{type:a,...(a==='maa'?{task:'Copilot'}:{})}});
  let actions = ['adapt_guide','maa','finish'];
  let observedRoster;
  const formationStates=[];
  const model = await listen(http.createServer(async(req,res)=>{
    let body=''; for await (const part of req) body+=part;
    const msgs=JSON.parse(body).messages;
    if (!msgs[0].content.includes('每位一人')) {
      const guidance=JSON.parse(msgs[1].content).guidance;
      observedRoster ??= guidance.roster;
      formationStates.push(guidance.formation);
    }
    const result = msgs[0].content.includes('每位一人') ? proposal : decision(actions.shift());
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  }),t);
  let devices=0; const native=[];
  const image = new PNG({width:320,height:180}), png = PNG.sync.write(image);
  const app=await listen(createServer({getHome:async()=>'fixture',getDevice:async()=>{
    devices++; return {capture:async()=>({png,width:320,height:180,client:'com.hypergryph.arknights'})};
  },native:async(a,options)=>native.push(options)}),t);
  const run = async extra=>{
    const res=await fetch(app+'/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      guide:author,roster:box,provider:'api',apiOptIn:true,url:model,model:'fixture',vision:false,instruction:'按我的干员适配并执行',...extra,
    })});
    return (await res.text()).trim().split('\n').map(JSON.parse);
  };
  const first = await run({});
  assert.equal(first.at(-1).outcome,'finish');
  assert.deepEqual(formationStates,[false,true,true]);
  assert.deepEqual(native[0].guide,first.find(e=>e.type==='guide_loaded').plan);
  assert.equal(native[0].guide.actions[1].name,'克洛丝'); assert.equal(native[0].formation,true);
  const sniper=observedRoster.operators.find(o=>o.name==='克洛丝');
  assert.equal(sniper.skill_level,7);
  assert.deepEqual(sniper.skill_levels,[7]);
  actions=['adapt_guide','finish'];
  assert.equal((await run({researchOnly:true})).at(-1).outcome,'finish');
  assert.equal(devices,1); assert.equal(native.length,1);
  actions=['maa'];
  assert.match((await run({researchOnly:true})).at(-1).text,/只读/);
});

test('首通自动编队传递缺位助战，普通指令和未开启自动编队时保留原检查',async t=>{
  const oldFile=process.env.ARK_REWARD_QUEUE;
  process.env.ARK_REWARD_QUEUE='fixture.json';
  t.after(()=>{if(oldFile===undefined) delete process.env.ARK_REWARD_QUEUE; else process.env.ARK_REWARD_QUEUE=oldFile;});
  let turns=0;
  const model=await listen(http.createServer((req,res)=>{
    const action=turns++===0 ? {type:'maa',task:'Copilot'} : {type:'finish'};
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'operate',goal:'核对首通',note:'核对作业',action})}}]}));
  }),t);
  const png=PNG.sync.write(new PNG({width:320,height:180})), runs=[];
  const app=await listen(createServer({
    getHome:async()=>'fixture',getDevice:async()=>({capture:async()=>({png,width:320,height:180,client:'com.hypergryph.arknights'})}),
    native:async(a,options)=>runs.push(options),
    runQueue:({runCommand,signal,emit})=>runCommand({instruction:'执行本关作业',guide:author,expectedStage:author.stage_name,limit:3,signal,emit}),
  }),t);
  async function send(instruction,formation) {
    turns=0;
    const res=await fetch(app+'/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      instruction,formation,guide:author,roster:box,provider:'api',apiOptIn:true,url:model,model:'fixture',serial:'device',vision:true,
    })});
    return (await res.text()).trim().split('\n').map(JSON.parse);
  }
  assert.ok((await send('/首通清单',true)).some(e=>e.type==='applied' && e.action.task==='Copilot'));
  assert.equal(runs[0].borrowSupport,true);
  for (const [instruction,formation] of [['/首通清单',false],['执行本关作业',true]]) {
    assert.ok((await send(instruction,formation)).some(e=>e.type==='research_error' && /名册/.test(e.text)));
  }
  assert.equal(runs.length,1);
});

test('集成战略站位根据实机宽高投影，同地图的普通与紧急编号可以分别查询', async () => {
  const result = await roguelikePlacements('苔手',{width:1600,height:900});
  const support = result.placements.find(step=>step.groups.includes('辅助'));
  assert.deepEqual(support,{groups:['辅助'],location:[4,2],direction:'left',terrain:'高台',dragTarget:[492,352]});
  assert.deepEqual(await roguelikePlacements('ro3_e_1_3',{width:1600,height:900}), result);
  for (const screen of [undefined,{width:800,height:600}]) {
    const board = await roguelikePlacements('ro3_n_1_3',screen);
    assert.equal(board.level,result.level);
    assert.ok(board.placements.length>0 && board.placements.every(step=>!('dragTarget' in step)));
  }
  await assert.rejects(roguelikePlacements('1-7'),/集成战略/);
  await assert.rejects(roguelikePlacements('../../Sami'),/集成战略/);
});
