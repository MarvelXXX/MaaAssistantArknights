import test from 'node:test';
import assert from 'node:assert/strict';
import { intelCheckout, runAgent, validateDecision } from '../lib/agent.mjs';

const frame = { width: 1600, height: 900, anchors: [{ id: 3, box: [600, 50, 90, 40] }], png: Buffer.from('frame') };
const answer = action => ({ intent: 'operate', goal: '打开任务界面', note: '检查任务入口', action });
test('情报凭证订单逐帧核实付款币种、总价、库存及余额，每单仅提交一次',async()=>{
  const width=1440,height=810,image={width,height,data:Buffer.alloc(width*height*4)};
  for (const [left,top,w,h] of [[1019,224,28,40],[1036,568,19,27]]) {
    for (let y=top+Math.ceil(h/3);y<top+h;y++) {
      for (let x=left;x<left+w;x++) image.data.set([155,152,255],4*(y*width+x));
    }
  }
  const order={lots:95,stock:864,tickets:1905};
  const labels=['合成玉','售价 20','×100','购买数量','剩余 864','总计支付 1900','购买物品'];
  const anchors=[...labels.map(label=>({label})),{label:'1905',box:[1340,25,90,30]}];
  const detail={width,height,image,anchors,png:Buffer.from('shop')};
  const button={type:'tap',x:1040,y:650};
  assert.equal(intelCheckout(detail,button,order,false),true);
  for (const changed of [{...order,lots:1},{...order,stock:865},{...order,tickets:1900},{...order,auditOnly:true}]) {
    assert.throws(()=>intelCheckout(detail,button,changed,false),/未提交/);
  }
  assert.throws(()=>intelCheckout(detail,button,order,true),/未提交/);
  const wrongTender={...detail,image:{width,height,data:Buffer.alloc(width*height*4,200)}};
  assert.throws(()=>intelCheckout(wrongTender,button,order,false),/未提交/);
  const f=fixture([{type:'tap',x:722,y:803}],{intelExchange:order,
    observe:async()=>f.emitted.some(e=>e.type==='decision') ? wrongTender : detail});
  await assert.rejects(runAgent(f.params),/未提交/);
  assert.equal(f.inputs.length,0);
});
test('动作按当前截图坐标映射，只接受当前帧的识别目标', () => {
  const parse = (a, readOnly = false, vision = true) => validateDecision(answer(a), frame, readOnly, vision).action;
  assert.deepEqual(parse({ type: 'tap', x: 1000, y: 0 }), { type: 'tap', x: 1599, y: 0 });
  assert.deepEqual(parse({ type: 'tap', id: 3 }, false, false), { type: 'tap', x: 645, y: 70 });
  for (const bad of [{ type:'tap', x:1001, y:0 }, { type:'tap', id:2 }, { type:'swipe', x:0, y:0, x2:10, y2:10, ms:'123' }, { type:'shell' }]) {
    assert.throws(() => parse(bad));
  }
  assert.throws(() => parse({ type:'tap', x:20, y:30 }, false, false), /文字模式/);
  assert.throws(() => parse({ type:'back' }, true), /只读/);
  assert.throws(() => validateDecision({ ...answer({type:'back'}), intent:'inspect' }, frame, false, true), /只读/);
});

function fixture(results, overrides = {}) {
  const inputs = [], emitted = [], abort = new AbortController();
  const params = { config: { vision: true }, instruction:'打开任务', history: [], readOnly: false, limit: 1,
    device: { capture: async () => frame, input: async a => inputs.push(a) },
    signal: abort.signal, emit: e => emitted.push(e), observe: async f => f, matches: () => true,
    pause: async () => {}, plan: async () => answer(results.shift()), ...overrides };
  return { inputs, emitted, abort, params };
}

test('视频执行记录保留实际匹配的分 P', async () => {
  const f = fixture([{type:'analyze_video',bv:'BV1uE421A7jm',stage:'AS-MO-1'},{type:'finish'}],{
    device:null,readOnly:true,lookupGuide:async ()=>({part:8,timestamps:[10.5,15.5]}),
  });
  await runAgent(f.params);
  assert.equal(f.emitted.find(e=>e.type==='applied').action.part,8);
});

test('首通决策临时断连后重新截图，保留此前已做动作且只等待两次',async()=>{
  const temporary=Object.assign(new Error('断连'),{code:'MODEL_TEMPORARY'}), observed=[], waits=[];
  let captures=0;
  const f=fixture([], {retryModel:true, limit:3, pause:async ms=>waits.push(ms),
    observe:async raw=>({...raw,sequence:++captures}),
    plan:async(_config,context,current)=>{
      observed.push([current.sequence,context.stepsSoFar]);
      if (observed.length===1) return answer({type:'tap',id:3});
      if (observed.length<5) throw temporary;
      return answer({type:'finish'});
    }});
  await assert.rejects(runAgent(f.params),e=>e===temporary);
  assert.deepEqual(observed,[[1,0],[2,1],[3,1],[4,1]]);
  assert.equal(f.inputs.length,1);
  assert.deepEqual(waits.filter(ms=>ms>=10000),[10000,30000]);
  const g=fixture([], {retryModel:true, plan:async()=>{if (!g.emitted.some(e=>e.text?.includes('重新观察当前画面'))) throw temporary;return answer({type:'finish'});}});
  await runAgent(g.params);
  assert.equal(g.emitted.at(-1).outcome,'finish');
  assert.equal(g.inputs.length,0);
  for (const [retryModel,error] of [[false,temporary],[true,Object.assign(new Error('HTTP 401'),{status:401})]]) {
    const h=fixture([],{retryModel,plan:async()=>{throw error;}});
    await assert.rejects(runAgent(h.params),e=>e===error);
    assert.equal(h.emitted.filter(e=>e.type==='frame').length,1);
  }
});
test('画面变化后跳过旧点击，最后一次观察可以确认结果', async () => {
  const f = fixture([{ type:'tap', id:3 }, { type:'ask' }], { matches: () => false });
  await runAgent(f.params);
  assert.equal(f.inputs.length, 0);
  assert.deepEqual(f.emitted.filter(e => ['stale','end'].includes(e.type)).map(e => e.type), ['stale','end']);
});
test('达到步数上限后仍读取最后一帧，但不继续操作', async () => {
  const f = fixture([{ type:'back' }, { type:'back' }]);
  await assert.rejects(runAgent(f.params), /上限/);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.emitted.filter(e => e.type === 'frame').length, 2);
});

test('无效输入不会发送，重新截图后仅允许一次修正',async()=>{
  const bad={type:'tap',x:1580,y:500};
  const f=fixture([bad,{type:'tap',id:3},{type:'finish'}]);
  await runAgent(f.params);
  assert.deepEqual(f.inputs,[{type:'tap',x:645,y:70}]);
  assert.equal(f.emitted.filter(e=>e.type==='frame').length,3);
  const again=fixture([bad,bad]);
  await assert.rejects(runAgent(again.params),/1000/);
  assert.equal(again.inputs.length,0);
});

test('用户禁止花费两种货币时，从当前帧拦截确认按钮，仍可关闭或领取免费报酬', async () => {
  const run = async (label, action, source='OCR') => {
    const f = fixture([action,{type:'finish'}], {instruction:'不能消耗源石和合成玉',
      observe: async () => ({...frame,anchors:[{...frame.anchors[0],label,source}]})});
    await runAgent(f.params);
    return f;
  };
  const tap = {type:'tap',id:3};
  for (const [label,source] of [['是否消耗 600 合成玉进行寻访？','OCR'],['源石恢复提示','Maa']]) {
    const f = await run(label,tap,source);
    assert.equal(f.inputs.length,0);
    assert.equal(f.emitted.at(-1).outcome,'stop');
  }
  assert.equal((await run('获得物资 至纯源石 ×1',tap)).inputs.length,1);
  assert.equal((await run('是否消耗1至纯源石恢复理智？',{type:'back'})).inputs.length,1);
});
test('模型返回时若已取消，设备不会收到动作', async () => {
  const f = fixture([]);
  f.params.plan = async () => { f.abort.abort(); return answer({type:'back'}); };
  await assert.rejects(runAgent(f.params), {name:'AbortError'});
  assert.equal(f.inputs.length, 0);
});

test('长巡查的中段读数在最近步骤滚动后仍送给模型', async () => {
  let lastContext;
  const f = fixture([], {limit:24, plan: async (_config,context) => {
    lastContext = context;
    const decision = answer(context.turn > 24 ? {type:'finish'} : {type:'wait',ms:300});
    decision.note = '第 ' + context.turn + ' 张地图已记录';
    return decision;
  }});
  await runAgent(f.params);
  assert.equal(lastContext.recentSteps.length,18);
  assert.deepEqual(lastContext.earlierObservations.map(s=>s.turn),[4,5,6,7,8,9]);
  assert.equal(lastContext.earlierObservations[3].note,'第 7 张地图已记录');
});
