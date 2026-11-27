import test from 'node:test';
import assert from 'node:assert/strict';
import { baseInspectionInput, intelCheckout, runAgent, validateDecision } from '../lib/agent.mjs';
import { intelBalanceCrop } from '../lib/vision.mjs';

const frame = { width: 1600, height: 900, anchors: [{ id: 3, box: [600, 50, 90, 40] }], png: Buffer.from('frame') };
const answer = action => ({ intent: 'operate', goal: '打开任务界面', note: '检查任务入口', action });
test('只读基建仅在离开确认框允许点击勾选，并在输入前重查',async()=>{
  const prompt={id:1,source:'OCR',label:'是否确认离开罗德岛基建 ？',box:[609,364,366,30]};
  const exit={...frame,anchors:[prompt]};
  const tap={type:'tap',x:1050,y:615};
  assert.equal(baseInspectionInput(exit,tap),true);
  assert.equal(baseInspectionInput(exit,{...tap,x:550}),false);
  assert.equal(baseInspectionInput(exit,{...tap,y:550}),false);
  const other={...frame,anchors:[{...prompt,label:'是否确认离开设施？'}]};
  assert.equal(baseInspectionInput(other,tap),false);
  assert.equal(baseInspectionInput({...exit,width:1280},tap),false);
  let reads=0;
  const game=fixture([{type:'tap',x:657,y:684}],{inspectBase:true,observe:async()=>++reads===1 ? exit : other});
  await assert.rejects(runAgent(game.params),/导航目标已变化/);
  assert.deepEqual(game.inputs,[]);
});
test('只查基建时拦截可直接收货的整张房间卡片，并在真实输入前复核导航',async()=>{
  const room={...frame,anchors:[
    {id:1,label:'进驻总览',box:[40,108,160,50]},
    {id:2,label:'贸易站',box:[190,336,105,42]},
    {id:3,label:'制造站',box:[240,606,110,35]},
  ]};
  assert.equal(baseInspectionInput(room,{type:'tap',x:237,y:358}),false);
  assert.equal(baseInspectionInput(room,{type:'tap',x:299,y:621}),false);
  assert.equal(baseInspectionInput(room,{type:'tap',x:100,y:135}),true);
  assert.equal(baseInspectionInput(room,{type:'swipe',x:237,y:358,x2:240,y2:360}),false);
  const f=fixture([{type:'tap',id:2},{type:'tap',id:3},{type:'tap',id:1},{type:'finish'}],{instruction:'只查看基建',observe:async()=>room});
  await runAgent(f.params);
  assert.deepEqual(f.inputs,[{type:'tap',x:120,y:133}]);
  assert.equal(f.emitted.filter(e=>e.type==='stale').length,2);
  let reads=0;
  const g=fixture([{type:'tap',id:1}],{inspectBase:true,observe:async()=>++reads===1 ? room : {...room,anchors:[room.anchors[1]]}});
  await assert.rejects(runAgent(g.params),/导航目标已变化/);
  assert.deepEqual(g.inputs,[]);
});
test('情报凭证订单逐帧核实付款币种、总价、库存及余额，每单仅提交一次',async()=>{
  const width=1440,height=810,image={width,height,data:Buffer.alloc(width*height*4)};
  for (const [left,top,w,h] of [[1019,224,28,40],[1036,568,19,27]]) {
    for (let y=top+Math.ceil(h/3);y<top+h;y++) {
      for (let x=left;x<left+w;x++) image.data.set([155,152,255],4*(y*width+x));
    }
  }
  const order={lots:95,stock:864,tickets:1905};
  const labels=['合成玉','售价 20','×100','购买数量','剩余 864','总计支付 1900','购买物品'];
  const anchors=[...labels.map(label=>({label})),{source:'凭证读数',label:'1905',box:[1340,25,90,30]}];
  const detail={width,height,image,anchors,png:Buffer.from('shop')};
  const button={type:'tap',x:1040,y:650};
  assert.equal(intelCheckout(detail,button,order,false),true);
  for (const changed of [{...order,lots:1},{...order,stock:865},{...order,tickets:1900},{...order,auditOnly:true}]) {
    assert.throws(()=>intelCheckout(detail,button,changed,false),/未提交/);
  }
  assert.throws(()=>intelCheckout(detail,button,order,true),/未提交/);
  const wrongTender={...detail,image:{width,height,data:Buffer.alloc(width*height*4,200)}};
  assert.throws(()=>intelCheckout(wrongTender,button,order,false),/未提交/);
  const f=fixture([{type:'tap',x:722,y:803},{type:'finish'}],{intelExchange:order,
    observe:async()=>f.emitted.some(e=>e.type==='decision') ? wrongTender : detail});
  await assert.rejects(runAgent(f.params),/未提交/);
  assert.equal(f.inputs.length,0);
});

test('凭证余额裁图独立校验字数，防止将末位 5 当作整笔余额',()=>{
  const width=1440,height=810,image={width,height,data:Buffer.alloc(width*height*4)};
  const frame={width,height,image,anchors:[{label:'合成玉'},{label:'购买物品'}]};
  assert.equal(intelBalanceCrop(frame),undefined);
  function mark(x){for (let y=34;y<55;y++) image.data.fill(250,4*(y*width+x),4*(y*width+x+9));}
  mark(1355);
  assert.equal(intelBalanceCrop(frame).digits,1);
  for (const x of [1371,1387,1403]) mark(x);
  assert.equal(intelBalanceCrop(frame).digits,4);
  assert.equal(intelBalanceCrop({...frame,anchors:[{label:'获得物资'}]}),undefined);
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

test('活动列表滑动后使用停稳的卡片位置，离开列表或在其他页面滑动及时交回',async()=>{
  const library=(y,heading='开启时间')=>({...frame,anchors:[
    {source:'OCR',label:heading,box:[1200,30,110,35]},
    {source:'OCR',label:'吾导先路',box:[700,y,120,30]},
    {source:'OCR',label:'尘影余音',box:[920,y,120,30]},
  ]});
  const other={...frame,anchors:[{source:'OCR',label:'首页',box:[80,60,60,40]}]};
  for (const [frames,expected,waits] of [
    [[library(620),library(340),library(270),library(265),library(265)],[620,265],[800,350,350,350]],
    [[library(620),library(340),other],[620,'首页'],[800,350]],
    [[library(620,'默认进度 奖励进度'),library(340,'默认进度 奖励进度'),library(340,'默认进度 奖励进度')],[620,340],[800,350]],
    [[other,other],['首页','首页'],[800]],
  ]) {
    const seen=[],delays=[];
    const game=fixture([],{
      observe:async()=>frames.shift(),
      pause:async ms=>delays.push(ms),
      plan:async(_config,_context,view)=>{
        seen.push(view.anchors[1]?.box[1]??view.anchors[0].label);
        return answer(seen.length===1?{type:'swipe',x:760,y:800,x2:760,y2:300,ms:450}:{type:'finish'});
      },
    });
    await runAgent(game.params);
    assert.deepEqual(seen,expected);
    assert.deepEqual(delays,waits);
    assert.equal(game.inputs.length,1);
  }
});

test('结算动画结束后才规划和发出截图，留在同一结算页只等一次', async () => {
  const ratings = ['结算二星标志','结算三星标志','结算三星标志'];
  const seen = [], waits = [];
  const f = fixture([], {
    observe: async () => ({...frame, anchors:[{label:ratings.shift()}]}),
    pause: async ms => waits.push(ms),
    plan: async (_config, _context, stable) => {
      seen.push(stable.anchors[0].label);
      return answer(seen.length === 1 ? {type:'wait',ms:300} : {type:'finish'});
    },
  });
  await runAgent(f.params);
  assert.deepEqual(seen,['结算三星标志','结算三星标志']);
  assert.deepEqual(waits,[4500,300]);
  assert.deepEqual(f.emitted.filter(e=>e.type==='frame').map(e=>e.anchors[0].label),seen);
});

test('Maa 提前交回仍在作战的画面时立即继续观察，切到结算才延时复核', async () => {
  const labels = ['编队页开始行动','战斗防御点图标','结算二星标志','结算三星标志'];
  const seen = [], waits = [];
  const actions = [{type:'maa',task:'Copilot'},{type:'wait',ms:300},{type:'finish'}];
  const f = fixture([], {
    limit:2, guidance:{plan:{stage:'test'}}, runNative:async () => '部署完毕',
    observe:async () => ({...frame, preview:'game', anchors:[{label:labels.shift()}]}),
    pause:async ms => waits.push(ms),
    plan:async (_config,_context,current) => {
      seen.push(current.anchors[0].label);
      return answer(actions.shift());
    },
  });
  await runAgent(f.params);
  assert.deepEqual(seen,['编队页开始行动','战斗防御点图标','结算三星标志']);
  assert.deepEqual(waits,[800,300,4500]);
});

test('Maa 返回空白过渡帧后单独等待真正的结算动画',async () => {
  const screens = [['编队页开始行动'],[],['结算二星标志'],['结算三星标志']];
  const seen = [], waits = [];
  const actions=[{type:'maa',task:'Copilot'},{type:'finish'}];
  const f=fixture([],{
    guidance:{plan:{stage:'test'}},runNative:async()=>{},
    observe:async()=>({...frame,preview:'game',anchors:screens.shift().map(label=>({label}))}),
    pause:async ms=>waits.push(ms),
    plan:async (_config,_context,current)=>{
      seen.push(current.anchors.map(a=>a.label));
      return answer(actions.shift());
    },
  });
  await runAgent(f.params);
  assert.deepEqual(seen,[['编队页开始行动'],['结算三星标志']]);
  assert.deepEqual(waits,[800,1000,4500]);
});

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

test('启动动画变化时只允许两帧都确认的明亮 START 图标', async () => {
  const data = Buffer.alloc(160 * 90 * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i+1] = 210; }
  const title = { ...frame, width: 160, height: 90, client: 'com.hypergryph.arknights', image: { data },
    anchors: [
      { id: 1, source: 'Maa', label: '启动页 START', box: [75,80,10,8], score: 0.998 },
      { id: 2, source: 'OCR', label: '清除缓存', box: [2,2,15,4] },
      { id: 3, source: 'OCR', label: '网络检测', box: [23,2,15,4] },
    ] };
  for (const [fresh, id, expected] of [
    [title, 1, 1], [title, 2, 0], [{...title, anchors: title.anchors.slice(1)}, 1, 0],
    [{...title, anchors: title.anchors.slice(0,2)}, 1, 0],
    [{...title, image: {data: Buffer.alloc(data.length)}}, 1, 0],
    [{...title, client: 'com.hypergryph.arknights.bilibili'}, 1, 0],
  ]) {
    const f = fixture([{type:'tap',id},{type:'finish'}], { matches: () => false });
    let captures = 0;
    f.params.device.capture = async () => ++captures === 1 ? title : fresh;
    await runAgent(f.params);
    assert.equal(f.inputs.length, expected);
  }
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
