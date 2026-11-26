import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { biliInfo, checkPlan, deploymentTarget, importGuide, matchesRewardStage, openBiliMedia, paradoxStageId, searchGuides } from '../lib/guides.mjs';
import { copilotDefeatReport, nativeAction, paradoxNavigationPlan, recognizedDefeat } from '../lib/maa.mjs';
import { normalizeRoster, rosterFit } from '../lib/roster.mjs';
import { runAgent, validateDecision } from '../lib/agent.mjs';
import { explainFrames } from '../lib/model.mjs';
import { matchesArchiveTitle } from '../lib/archive-navigation.mjs';
import { nativeCommand } from '../public/native-commands.js';

const plan = {stage_name:'main_01-07', opers:[{name:'令',skill:3}], actions:[
  {type:'Deploy',name:'令',location:[2,3],direction:'Right'}, {type:'Skill',name:'令',kills:12},
]};
const getSignal = () => AbortSignal.timeout(10000);
const reply = (action,intent='operate') => ({intent,goal:'查作业',note:'核对结果',action});

test('常驻地图指令限定普通关号，曲谱可识别国服活动的英文标志', () => {
  const action=nativeCommand('/定位活动关卡 go-1');
  assert.deepEqual(action,{task:'ArchiveStage',stage:'GO-1'});
  assert.deepEqual(nativeCommand('/定位活动关卡 go-tr-1'),{task:'ArchiveStage',stage:'GO-TR-1'});
  assert.deepEqual(nativeAction({...action,times:4,task_names:['Fight']},false),{type:'maa',...action});
  assert.equal(nativeCommand('/定位活动关卡 GO-1-Hard'),null);
  assert.throws(()=>nativeAction({task:'ArchiveStage',stage:'GO-1@Fight'},false));
  const target={chapter:'追迹日落以西',englishTitle:'Ending A Grand Overture'};
  assert.equal(matchesArchiveTitle('A GRAND OVERTURE',target),true);
  assert.equal(matchesArchiveTitle('追 迹 日 落 以 西',target),true);
  assert.equal(matchesArchiveTitle('OVERTURE',target),false);
});

test('原生任务链结束时保留实战失败回调与最近一次有效击倒数', async t => {
  const defeat = {details:{task:'FightMissionFailed-Bypass',result:{text:'任务失败'}}};
  assert.equal(recognizedDefeat('20001',defeat),true);
  assert.equal(recognizedDefeat('20002',{details:{task:'Copilot@FightMissionFailedAndStop'}}),true);
  assert.equal(recognizedDefeat('20003',defeat),false);
  assert.equal(recognizedDefeat('20001',{pre_task:defeat.details.task,details:{task:'EndOfAction-Bypass'}}),false);
  const work = await mkdtemp(path.join(tmpdir(),'arkpilot-defeat-test-'));
  t.after(()=>rm(work,{force:true,recursive:true}));
  assert.equal(await copilotDefeatReport(work,''),'Maa 已识别到本局任务失败。');
  await mkdir(path.join(work,'debug'));
  await writeFile(path.join(work,'debug','asst.log'),'[TRC] Kills: 1 / 68\r\n[TRC] Kills: 3 / 68\r\n[TRC] Kills: 69 / 68\r\n');
  assert.match(await copilotDefeatReport(work,'UseSkill · 德克萨斯'),/最后识别的击倒数 3\/68。失败前最后尝试的作业动作 UseSkill · 德克萨斯/);
  const trace = '[TRC] Waiting for end of action\r\n'.repeat(10000);
  await writeFile(path.join(work,'debug','asst.log'),'[TRC] Kills: 15 / 19\r\n'+trace+'[TRC] Kills: 21 / 19\r\n');
  const report = await copilotDefeatReport(work,'SwitchSpeed',new Map([['崖心',3],['蛇屠箱',1]]));
  assert.match(report,/最后识别的击倒数 15\/19/);
  assert.match(report,/最后尝试的作业动作 SwitchSpeed/);
  assert.match(report,/崖心 ×3、蛇屠箱 ×1.*等待触发条件前/);
});

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

test('视频范围请求可跟随一次可信 CDN 跳转，并在请求未知目标前停止', async t => {
  const cdn='0123456789abcdef0123456789abcdef.v.smtcdns.com';
  let destination='https://'+cdn+'/video.mp4';
  let followed=0;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const u=new URL(url);
    if (u.pathname.endsWith('/view')) return Response.json({code:0,data:{pages:[{cid:3}]}});
    if (u.pathname.endsWith('/playurl')) return Response.json({code:0,data:{format:'mp4720',durl:[{url:'https://test.bilivideo.com/video',size:40}]}});
    assert.equal(options.headers.Range,'bytes=4-7');
    if (u.hostname==='test.bilivideo.com') {
      assert.equal(options.redirect,'manual');
      return new Response(null,{status:302,headers:{location:destination}});
    }
    assert.equal(u.hostname,cdn);
    assert.equal(options.redirect,'error');
    followed++;
    return new Response(new Uint8Array(4),{status:206,headers:{'content-range':'bytes 4-7/40'}});
  });
  const read=()=>openBiliMedia('BV2123456789',1,getSignal(),'bytes=4-7');
  const result=await read();
  assert.equal(result.status,206);
  assert.equal(result.headers.get('content-range'),'bytes 4-7/40');
  assert.equal((await result.arrayBuffer()).byteLength,4);
  for (destination of ['http://'+cdn+'/video','https://'+cdn+':5443/video','https://127.0.0.1/video','https://'+cdn+'.example.com/video']) {
    await assert.rejects(read(),/不支持的媒体跳转/);
  }
  assert.equal(followed,1);
});

test('按分 P 标题匹配完整关号，保留显式选段并提示同关的多个版本', async t => {
  const pages = ['AS-S-1','AS-MO-10','攻略 AS－MO－1 普通'].map((part,i)=>({part,cid:i+1,duration:90}));
  t.mock.method(globalThis,'fetch',async ()=>Response.json({code:0,data:{pages}}));
  const lookup = (part,stage)=>biliInfo('BV0123456789',part,getSignal(),stage);
  assert.equal((await lookup(undefined,'act35side_mo01')).part,3);
  assert.equal((await lookup(1)).part,1);
  assert.equal((await lookup()).part,1);
  await assert.rejects(lookup(1,'AS-MO-1'),/P3/);
  pages.push({part:'AS-MO-1 低配',cid:4,duration:120});
  await assert.rejects(lookup(undefined,'AS-MO-1'),/P3.+P4/);
  assert.equal((await lookup(4,'AS-MO-1')).page.cid,4);
  await assert.rejects(lookup(undefined,'SL-7'),/P1 AS-S-1/);
});

test('悖论列表导航使用空编队作业注明的手选技能', async () => {
  const stage = 'mem_demkni_1';
  const guide = {...plan,stage_name:stage,opers:[],doc:{details:'进入选技能界面，手选3技能进入关卡'}};
  const prepared = await paradoxNavigationPlan(guide,stage);
  assert.deepEqual(prepared.opers,[{name:'塞雷娅',skill:3}]);
  assert.deepEqual(guide.opers,[]);
  assert.equal(prepared.actions,guide.actions);
  assert.equal(await paradoxNavigationPlan(prepared,stage),prepared);
  const defaults = {...guide,doc:{details:'开局部署塞雷娅'}};
  assert.equal(await paradoxNavigationPlan(defaults,stage),defaults);
  for (const details of ['手选二技能或三技能','手选二技能，手动选择三技能。']) {
    await assert.rejects(paradoxNavigationPlan({...guide,doc:{details}},stage),{beforeStart:true});
  }
});

test('悖论视频合集按完整关名选分 P，多个版本或错误分 P 要求核对', async t => {
  const pages = ['万箭齐发进阶', '#8【流星】万箭齐发', '流星其他关卡'].map((part,i)=>({part,cid:i+1,duration:142}));
  t.mock.method(globalThis,'fetch',async()=>Response.json({code:0,data:{pages}}));
  const lookup = part => biliInfo('BV0123456789',part,getSignal(),'mem_shotst_1');
  assert.equal((await lookup()).part,2);
  await assert.rejects(lookup(1),/P2/);
  pages.push({part:'万箭齐发',cid:4,duration:180});
  await assert.rejects(lookup(),/P2.+P4/);
  assert.equal((await lookup(4)).part,4);
});

test('悖论作业缺编队时使用已核实的技能，保留站位和作业声明', async () => {
  const stage = 'mem_shotst_1';
  const empty = {...plan,stage_name:stage,opers:[],groups:[],doc:{details:'万箭齐发'}};
  const action = nativeAction({task:'ParadoxCopilot',skill:2},true);
  assert.equal(action.skill,2);
  const prepared = await paradoxNavigationPlan(empty,stage,action.skill);
  assert.deepEqual(prepared.opers,[{name:'流星',skill:2}]);
  assert.equal(prepared.actions,empty.actions);
  assert.deepEqual(empty.opers,[]);
  assert.equal(await paradoxNavigationPlan(empty,stage),empty);
  const authored = {...empty,doc:{details:'手选1技能进入关卡'}};
  await assert.rejects(paradoxNavigationPlan(authored,stage,2),{beforeStart:true});
  await assert.rejects(paradoxNavigationPlan(prepared,stage,1),{beforeStart:true});
  await assert.rejects(paradoxNavigationPlan(empty,stage,3),{beforeStart:true});
  assert.throws(()=>nativeAction({task:'ParadoxCopilot',skill:0},true));
  assert.throws(()=>nativeAction({task:'ParadoxCopilot',skill:'2'},true));
});

test('作业必须包含有效的部署与编队，模型无权传入原生任务参数', () => {
  assert.equal(checkPlan(plan),plan);
  const mine = {type:'部署',name:'干扰地雷',location:[1,2]};
  assert.equal(checkPlan({...plan,actions:[mine]}).actions[0].direction,'Right');
  assert.equal(mine.direction,undefined);
  assert.throws(()=>checkPlan({...plan,actions:[{...mine,direction:'南'}]}),/朝向/);
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

  const activity = {instruction:'/活动合成玉',guide:null,native:null};
  assert.equal((await send({...activity,readOnly:true})).status,400);
  assert.equal((await send({...activity,researchOnly:true})).status,400);
  assert.equal(calls.length,1);
  const free = await send(activity);
  const activityEvents = (await free.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[1].a,{type:'maa',task:'ActivityOrundum'});
  assert.equal(activityEvents.at(-1).outcome,'finish');
  assert.match(activityEvents.at(-1).note,/检查幸运墙和限时开采/);
  assert.deepEqual(nativeAction({task:'ActivityOrundum',recruit:true,mail:true},false),calls[1].a);
  const skip = await send({...activity,instruction:'/跳过剧情'});
  assert.match(await skip.text(),/"outcome":"finish"/);
  assert.deepEqual(calls[2].a,{type:'maa',task:'SkipStory'});
  assert.deepEqual(nativeAction({task:'SkipStory',task_names:['Fight']},false),calls[2].a);
  const dismiss = await send({...activity,instruction:'/退出结算'});
  assert.match(await dismiss.text(),/"outcome":"finish"/);
  assert.deepEqual(calls[3].a,{type:'maa',task:'DismissResult'});
  for (const [instruction,task] of [['/返回首页','ReturnHome'],['/作战终端','OpenTerminal']]) {
    assert.equal((await send({...activity,instruction,readOnly:true})).status,400);
    assert.match(await (await send({...activity,instruction})).text(),/"outcome":"finish"/);
    assert.deepEqual(calls.at(-1).a,{type:'maa',task});
  }
  assert.equal((await send({...activity,instruction:'/悖论作业'})).status,400);
  assert.equal(calls.length,6);
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
