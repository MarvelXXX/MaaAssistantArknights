import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { checkPlan, deploymentTarget, importGuide, matchesRewardStage, openBiliMedia, paradoxStageId, searchGuides } from '../lib/guides.mjs';
import { nativeAction } from '../lib/maa.mjs';
import { normalizeRoster, rosterFit } from '../lib/roster.mjs';
import { runAgent, validateDecision } from '../lib/agent.mjs';
import { explainFrames } from '../lib/model.mjs';

const plan = {stage_name:'main_01-07', opers:[{name:'令',skill:3}], actions:[
  {type:'Deploy',name:'令',location:[2,3],direction:'Right'}, {type:'Skill',name:'令',kills:12},
]};
const getSignal = () => AbortSignal.timeout(10000);
const reply = (action,intent='operate') => ({intent,goal:'查作业',note:'核对结果',action});

test('解析带清晰度的单段 MP4 并保留 Range，拒绝其他封装', async t => {
  let format='mp4720';
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const u=new URL(url);
    if (u.pathname.endsWith('/view')) return Response.json({code:0,data:{pages:[{cid:123,duration:60}]}});
    if (u.pathname.endsWith('/playurl')) return Response.json({code:0,data:{format,durl:[{url:'https://test.bilivideo.com/file.mp4',size:30}]}});
    assert.equal(options.headers.Range,'bytes=0-3');
    return new Response(new Uint8Array([0,1,2,3]),{status:206});
  });
  const result=await openBiliMedia('BV0123456789',1,getSignal(),'bytes=0-3');
  assert.equal(result.status,206);
  assert.equal((await result.arrayBuffer()).byteLength,4);
  format='flv720';
  await assert.rejects(openBiliMedia('BV1123456789',1,getSignal()),/单段公开 MP4/);
});

test('作业必须包含有效的部署与编队，模型无权传入原生任务参数', () => {
  assert.equal(checkPlan(plan),plan);
  assert.throws(() => checkPlan({...plan,groups:[{name:'先锋'}]}),/编队/);
  assert.throws(() => checkPlan({...plan,actions:[{type:'Deploy',name:'令'}]}),/部署/);
  assert.throws(() => nativeAction({task:'Custom'},true));
  assert.throws(() => nativeAction({task:'Copilot'},false));
  assert.throws(() => nativeAction({task:'ParadoxCopilot'},false));
  assert.deepEqual(nativeAction({task:'Fight',stage:'ce-6',times:2,stone:100}),{type:'maa',task:'Fight',stage:'CE-6',times:2});
  assert.throws(() => validateDecision(reply({type:'maa',task:'Award'}),{},true,true,true),/只读/);
  assert.equal(validateDecision(reply({type:'find_guide',stage:'1-7'},'inspect'),{},true,true).action.stage,'1-7');
});

test('悖论作业按游戏关卡数据匹配并使用专用导航任务', async () => {
  for (const stage_name of ['睥睨','mem_svrash_1','obt/memory/level_memory_svrash_1']) {
    assert.equal(await paradoxStageId({stage_name}),'mem_svrash_1');
  }
  assert.equal(await paradoxStageId(plan),null);
  assert.equal(await paradoxStageId({stage_name:'mem_nonexistent_1'}),null);
  assert.deepEqual(nativeAction({task:'ParadoxCopilot',filename:'ignored'},true),{type:'maa',task:'ParadoxCopilot'});
});

test('教学关使用拖卡时的镜头定位，拒绝地图外或不可部署的位置', async () => {
  assert.deepEqual(await deploymentTarget('TR-S-1',[2,2],1600,900),{x:726,y:346});
  assert.deepEqual(await deploymentTarget('TR-S-1',[4,3],1600,900),{x:968,y:424});
  await assert.rejects(deploymentTarget('TR-S-1',[0,0],1600,900),/不可部署/);
  await assert.rejects(deploymentTarget('TR-S-1',[2,2],800,800),/16:9/);
});

test('用关卡索引查询作业摘要，按同一 BV 过滤，再获取完整动作', async t => {
  const urls = [];
  t.mock.method(globalThis,'fetch',async url => {
    urls.push(String(url));
    if (String(url).includes('/query?')) {
      const rows = ['BV1QY411L7H2','另一个视频'].map((details,i) => ({id:11+i,content:JSON.stringify({stage_name:'main_01-07',doc:{title:'令单核',details}})}));
      return Response.json({status_code:200,data:{data:rows}});
    }
    return Response.json({status_code:200,data:{content:JSON.stringify(plan)}});
  });
  const signal = getSignal();
  const rows = await searchGuides('1-7',signal,'BV1QY411L7H2');
  assert.equal(new URL(urls[0]).searchParams.get('levelKeyword'),'main_01-07');
  assert.deepEqual(rows,[{id:'11',title:'令单核'}]);
  assert.deepEqual((await importGuide('maa://11',signal)).plan,plan);
  await assert.rejects(importGuide('https://example.org/11',signal),/支持/);
});

test('同名活动关和悖论能分别检索，首通任务核对实际关卡 ID', async t => {
  t.mock.method(globalThis,'fetch',async url => {
    const id=new URL(url).searchParams.get('levelKeyword');
    const data=id==='mem_huang_1'?[{id:45047,content:JSON.stringify({stage_name:id,doc:{title:'煌'}})}]:[];
    return Response.json({status_code:200,data:{data}});
  });
  assert.deepEqual(await searchGuides('一夫当关',getSignal()),[{id:'45047',title:'煌',stage:'mem_huang_1'}]);
  assert.equal(await matchesRewardStage({stage_name:'BW-5'},'mem_huang_1'),false);
  assert.equal(await matchesRewardStage({stage_name:'ZT-1'},'act29side_01'),true);
});

test('按名册检索保留未知编队，优先列出技能和组内候选已核对的作业',async t=>{
  const roster=await normalizeRoster({operators:[{name:'芬',elite:1,level:1,skill_level:4},{name:'德克萨斯',elite:2,level:50,skill_level:7}]});
  const early={name:'芬',skill:1,requirements:{skill_level:7}};
  const ready={name:'德克萨斯',skill:1,requirements:{skill_level:7}};
  const plans=[{}, {opers:[early]}, {opers:[{name:'芬',skill:1}]}, {groups:[{name:'先锋',opers:[early,ready]}]}];
  t.mock.method(globalThis,'fetch',async()=>Response.json({status_code:200,data:{
    data:plans.map((p,i)=>({id:10+i,content:JSON.stringify({stage_name:'main_01-07',...p})})),
  }}));
  const rows=await searchGuides('1-7',getSignal(),'',false,p=>rosterFit(p,roster));
  assert.deepEqual(rows.map(r=>[r.id,r.unconfirmedSlots]),[['13',[]],['12',[]],['11',['芬']],['10',undefined]]);
  assert.deepEqual(rows[0].leastTrained,{name:'德克萨斯',elite:2,level:50});
});

test('对话中查到的作业可调用 Maa，Maa 完成后再次截图', async () => {
  const actions = [{type:'find_guide',stage:'1-7'},{type:'load_guide',id:'11'},{type:'maa',task:'Copilot'},{type:'finish'}];
  const emitted = [], native = [], guidance = {};
  let captures = 0;
  await runAgent({config:{vision:false},device:{capture:async () => { captures++; return {}; }},
    instruction:'查找并执行作业',history:[],readOnly:false,limit:3,signal:getSignal(),emit:e=>emitted.push(e),
    observe:async f=>f,plan:async()=>reply(actions.shift()),guidance,
    lookupGuide:async a => { if (a.type === 'load_guide') guidance.plan = {stage:'main_01-07'}; return 'ok'; },
    runNative:async a => native.push(a),pause:async()=>{}});
  assert.equal(captures,4);
  assert.deepEqual(native,[{type:'maa',task:'Copilot'}]);
  assert.equal(emitted.at(-1).count,3);
});

test('原生任务支持免模型执行，遵守只读模式及服务端独占', async t => {
  const calls = [];
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  const server = createServer({getHome:async ()=>'test',getDevice:async()=>({}),native:async (a,options) => {
    calls.push({a,options}); options.progress?.('正在运行'); await gate; return 'test';
  }});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{release();server.closeAllConnections();server.close();});
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (extra={}) => fetch(base+'/api/run',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({serial:'emulator-1',instruction:'执行作业',native:{task:'Copilot',filename:'bad'},guide:plan,...extra})});
  assert.equal((await send({readOnly:true})).status,400);
  assert.equal(calls.length,0);
  const result = await send();
  assert.equal((await send()).status,409);
  release();
  const events = (await result.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).outcome,'finish'); assert.equal(events.some(e=>e.type==='core'),true);
  assert.deepEqual(calls[0].a,{type:'maa',task:'Copilot'});
  assert.deepEqual(calls[0].options.guide,plan);
});

test('同一指令依次打不同悖论，同一关重复时停止', async () => {
  const guidance = {plan:{stage:'mem_svrash_1'}};
  const run = {type:'maa',task:'ParadoxCopilot'};
  const actions = [run,{type:'load_guide',id:'21247'},run,run];
  const stages = [];
  await assert.rejects(runAgent({
    config:{vision:false},device:{capture:async()=>({})},instruction:'完成两个悖论',history:[],
    readOnly:false,limit:5,signal:getSignal(),emit:()=>{},observe:async f=>f,
    plan:async()=>reply(actions.shift()),guidance,pause:async()=>{},
    lookupGuide:async()=>{ guidance.plan = {stage:'mem_meltha_1'}; return guidance.plan; },
    runNative:async()=>{stages.push(guidance.plan.stage);},
  }), /重复执行/);
  assert.deepEqual(stages,['mem_svrash_1','mem_meltha_1']);
});

test('Maa 中断后重新观察实机且不再次开战', async () => {
  let attempts = 0, observations = 0;
  const events = [], actions = [{type:'maa',task:'Copilot'},{type:'finish'}];
  await runAgent({config:{vision:false},device:{capture:async()=>({})},instruction:'完成本关',history:[],
    readOnly:false,limit:2,signal:getSignal(),emit:e=>events.push(e),pause:async()=>{},
    observe:async f=>{observations++;return f;},guidance:{plan:{stage:'tr_s_1'}},
    plan:async()=>reply(actions.shift()),runNative:async()=>{attempts++;throw new Error('task chain incomplete');}});
  assert.equal(attempts,1);
  assert.equal(observations,2);
  assert.ok(events.some(e=>e.text?.includes('Maa 未确认完成')));
  assert.ok(!events.some(e=>e.type==='applied'));
});

test('视频笔记只提交带时间的内联帧，拒绝远程图片替换', async t => {
  const signal = getSignal();
  const config = {url:'http://localhost/v1',model:'test',vision:true};
  const frames = [1,3].map(seconds => ({seconds,image:'data:image/jpeg;base64,/9j/AQ=='}));
  let sent;
  t.mock.method(globalThis,'fetch',async (_url,req) => {
    sent = JSON.parse(req.body); return Response.json({choices:[{message:{content:'1 秒：关卡准备页'}}]});
  });
  await assert.rejects(explainFrames(config,[frames[0],{seconds:3,image:'http://localhost/other'}],signal),/格式/);
  const result = await explainFrames(config,frames,signal);
  assert.match(result.notes,/1 秒/);
  assert.deepEqual(sent.messages[1].content.map(p=>p.type),['text','image_url','text','image_url']);
});
