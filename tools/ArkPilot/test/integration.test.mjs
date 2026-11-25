import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createServer } from '../server.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { stillMatches } from '../lib/vision.mjs';
import { runAgent } from '../lib/agent.mjs';

function makeFrame(red, blue) {
  const image = new PNG({ width: 320, height: 180 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = red; image.data[i+2] = blue; image.data[i+3] = 255;
  }
  return { png: PNG.sync.write(image), width: 320, height: 180, client: 'com.hypergryph.arknights' };
}
async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}
test('HTTP 对话经兼容模型返回点击，重新截图确认，并支持纯文本追问', async t => {
  const screens = [makeFrame(120, 0), makeFrame(0, 120)];
  let scene = 0;
  let incompleteRequest;
  const inputs = [], requests = [];
  const device = { capture: async () => screens[scene], input: async action => { inputs.push(action); scene = 1; } };
  const model = await listen(http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer example-test-key') { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('{}'); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    if (!incompleteRequest) {
      incompleteRequest = request;
      return res.end('{"choices":[');
    }
    requests.push(request);
    const reply = { intent: requests.length === 3 ? 'inspect' : 'operate', goal: '打开任务界面',
      note: scene ? '已看到目标页面' : '点击入口', action: scene ? { type:'finish' } : { type:'tap', x:250, y:500 } };
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  }), t);
  const app = await listen(createServer({ getDevice: async () => device }), t);
  const data = { url: model + '/v1', key:'example-test-key', serial:'test', instruction:'打开任务界面', limit:1 };
  const post = async (fields, origin = app) => fetch(app + '/api/run', {
    method:'POST', headers:{'Content-Type':'application/json',Origin:origin}, body: JSON.stringify({...data, ...fields}) });
  assert.equal((await post({}, 'http://another.example')).status, 403);
  const run = await post({});
  assert.equal(run.status, 200);
  const events = (await run.text()).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(events.at(-1).outcome, 'finish');
  assert.deepEqual(inputs, [{ type:'tap', x:80, y:90 }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], incompleteRequest);
  assert.equal(requests[0].model, 'test-model');
  const [first, last] = requests.map(r => r.messages[1].content);
  assert.match(first[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.notEqual(first[1].image_url.url, last[1].image_url.url);
  assert.equal(JSON.parse(last[0].text).recentSteps[0].action.type, 'tap');
  const history = [{role:'assistant',text:'已看到目标页面'}];
  const followup = await post({ url: model + '/v1/chat/completions', model:'test-model',
    vision:false, readOnly:true, instruction:'刚才到了哪里？', history });
  assert.match(await followup.text(), /"outcome":"finish"/);
  const text = requests[2].messages[1].content;
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text).conversation, history);
  assert.equal(text.includes('data:image'), false);
  assert.equal(inputs.length, 1);
});

test('仅目标区域变化时也丢弃过期点击', () => {
  const frame = makeFrame(0, 0);
  const image = PNG.sync.read(frame.png);
  const changed = PNG.sync.read(frame.png);
  for (let y = 30; y < 70; y++) {
    for (let x = 30; x < 70; x++) changed.data[(y * changed.width + x) * 4] = 255;
  }
  const after = { ...frame, png: PNG.sync.write(changed) };
  assert.equal(stillMatches({ ...frame, image }, after, {type:'tap',x:50,y:50}), false);
  assert.equal(stillMatches({ ...frame, image }, after, {type:'tap',x:200,y:100}), true);
});

test('拖卡到作业格后只在新出现朝向框时确认方向', async () => {
  const battle = {...makeFrame(0,0),anchors:[{label:'剩余可放置角色：4'}]};
  const selected = PNG.sync.read(battle.png);
  for (let y=40; y<55; y++) for (let x=100; x<119; x++) {
    const i=(y*selected.width+x)*4;
    selected.data[i]=230;
    if (x>=110 && x<114) {selected.data[i+1]=235;selected.data[i+2]=235;}
  }
  const guidance = {plan:{stage:'tr_s_1',firstActions:[{type:'Deploy',name:'克洛丝',location:[2,2],direction:'Right'}]}};
  for (const visible of [false,true]) {
    const inputs=[];
    const state = () => visible && inputs.length ? {...battle,png:PNG.sync.write(selected)} : battle;
    await runAgent({config:{vision:true},device:{capture:async()=>state(),input:async a=>{inputs.push(a);}},
      instruction:'按已选作业部署克洛丝，禁止使用源石',history:[],readOnly:false,limit:2,
      signal:AbortSignal.timeout(3000),emit:()=>{},guidance,pause:async()=>{},observe:async frame=>frame,
      plan:async()=>({intent:'operate',goal:'部署',note:'核对卡片',action:inputs.length?{type:'finish'}:{type:'deploy',step:1,x:900,y:915}})});
    assert.equal(inputs.length,visible ? 2 : 1);
    assert.deepEqual([inputs[0].x2,inputs[0].y2],[145,69]);
    if (visible) assert.ok(inputs[1].x2>inputs[1].x && inputs[1].y2===inputs[1].y);
  }
});

test('等待模型时独占设备，浏览器断开后释放任务', { timeout: 12000 }, async t => {
  let requested;
  const thinking = new Promise(resolve => { requested = resolve; });
  const model = await listen(http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { requested(); });
    res.on('close', () => res.end());
  }), t);
  const frame = makeFrame(20, 20);
  const inputs = [];
  const app = await listen(createServer({getDevice: async () => ({
    capture: async () => frame, input: async a => inputs.push(a),
  })}), t);
  const cancel = new AbortController();
  const send = signal => fetch(app + '/api/run', { method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ model:'test', url:model, serial:'test', instruction:'领取任务奖励' }), signal });
  const stream = await send(cancel.signal);
  assert.equal(stream.status, 200);
  await thinking;
  assert.equal((await send()).status, 409);
  cancel.abort();
  for (let i = 0; i < 50; i++) {
    if (!(await (await fetch(app + '/api/health')).json()).active) break;
    await delay(50);
  }
  assert.equal((await (await fetch(app + '/api/health')).json()).active, false);
  assert.equal(inputs.length, 0);
});

test('部署栏漏识别后仍在同一局，用击杀数和费用图标重新确认拖卡', async () => {
  const shot=makeFrame(0,0);
  const inputs=[], events=[];
  let observations=0;
  const deploy={type:'deploy',step:1,x:900,y:920};
  await runAgent({config:{vision:true},device:{capture:async()=>shot,input:async a=>inputs.push(a)},
    instruction:'继续本局，部署克洛丝',history:[],readOnly:false,limit:3,signal:AbortSignal.timeout(3000),
    guidance:{plan:{stage:'tr_s_1',firstActions:[{type:'Deploy',name:'克洛丝',location:[2,2],direction:'None'}]}},
    emit:e=>events.push(e),matches:()=>true,pause:async()=>{},
    observe:async frame=>({...frame,anchors:++observations===1 ? [] : [
      {label:'3 / 9',source:'OCR',box:[142,4,21,9]}, {label:'战斗部署费用图标',source:'Maa'}]}),
    plan:async()=>({intent:'operate',goal:'继续教学',note:'核对战场',action:inputs.length?{type:'finish'}:deploy})});
  assert.equal(inputs.length,1);
  assert.equal(inputs[0].type,'swipe');
  assert.ok(events.some(e=>e.type==='stale' && e.text.includes('未拖卡')));
  assert.equal(events.at(-1).outcome,'finish');
});
