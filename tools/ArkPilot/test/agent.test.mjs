import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, validateDecision } from '../lib/agent.mjs';

const frame = { width: 1600, height: 900, anchors: [{ id: 3, box: [600, 50, 90, 40] }], png: Buffer.from('frame') };
const answer = action => ({ intent: 'operate', goal: '打开任务界面', note: '检查任务入口', action });
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
