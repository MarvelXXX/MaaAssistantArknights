import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { checkPlan, importGuide, searchGuides } from '../lib/guides.mjs';
import { nativeAction } from '../lib/maa.mjs';
import { runAgent, validateDecision } from '../lib/agent.mjs';
import { explainFrames } from '../lib/model.mjs';

const plan = {stage_name:'main_01-07', opers:[{name:'令',skill:3}], actions:[
  {type:'Deploy',name:'令',location:[2,3],direction:'Right'}, {type:'Skill',name:'令',kills:12},
]};
const getSignal = () => AbortSignal.timeout(10000);
const reply = (action,intent='operate') => ({intent,goal:'查作业',note:'核对结果',action});

test('作业必须包含有效的部署与编队，模型无权传入原生任务参数', () => {
  assert.equal(checkPlan(plan),plan);
  assert.throws(() => checkPlan({...plan,groups:[{name:'先锋'}]}),/编队/);
  assert.throws(() => checkPlan({...plan,actions:[{type:'Deploy',name:'令'}]}),/部署/);
  assert.throws(() => nativeAction({task:'Custom'},true));
  assert.throws(() => nativeAction({task:'Copilot'},false));
  assert.deepEqual(nativeAction({task:'Fight',stage:'ce-6',times:2,stone:100}),{type:'maa',task:'Fight',stage:'CE-6',times:2});
  assert.throws(() => validateDecision(reply({type:'maa',task:'Award'}),{},true,true,true),/只读/);
  assert.equal(validateDecision(reply({type:'find_guide',stage:'1-7'},'inspect'),{},true,true).action.stage,'1-7');
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
