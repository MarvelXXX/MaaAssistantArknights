import { setTimeout as delay } from 'node:timers/promises';
import { recognize, stillMatches } from './vision.mjs';
import { decide } from './model.mjs';
import { nativeAction } from './maa.mjs';

const endTypes = new Set(['finish', 'ask', 'stop']);
function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('模型返回的动作参数越界或缺失。');
  return value;
}

export function validateDecision(reply, frame, readOnly, vision, maaAvailable = false, hasPlan = false) {
  if (!reply || !['inspect', 'operate'].includes(reply.intent) || typeof reply.goal !== 'string' ||
      !reply.goal.trim() || typeof reply.note !== 'string' || !reply.note.trim() ||
      !reply.action || typeof reply.action !== 'object') throw new Error('模型决策缺少意图、说明或动作。');
  const a = reply.action;
  const decision = { intent: reply.intent, goal: reply.goal.slice(0, 300), note: reply.note.slice(0, 4000) };
  if (endTypes.has(a.type)) return { ...decision, action: { type: a.type } };
  if (a.type === 'find_guide' && typeof a.stage === 'string' && a.stage.trim() && a.stage.length <= 100) {
    return {...decision, action:{type:a.type,stage:a.stage.trim()}};
  }
  if (a.type === 'load_guide' && typeof a.id === 'string' && /^[1-9]\d{0,9}$/.test(a.id)) {
    return {...decision, action:{type:a.type,id:a.id}};
  }
  if (readOnly || reply.intent === 'inspect') throw new Error('只读分析收到了操作指令，已停止。');
  let action;
  const px = (n, size) => Math.round(integer(n, 0, 1000) * (size - 1) / 1000);
  switch (a.type) {
    case 'maa':
      if (!maaAvailable) throw new Error('未配置 MaaCore。');
      action = nativeAction(a, hasPlan);
      break;
    case 'tap': {
      let x, y;
      if ('id' in a) {
        if ('x' in a || 'y' in a) throw new Error('点击目标不唯一。');
        const target = frame.anchors.find(t => t.id === a.id);
        if (!target) throw new Error('模型选取的目标不在当前识别结果中。');
        const [l, t, w, h] = target.box;
        x = integer(Math.round(l + w / 2), 0, frame.width - 1);
        y = integer(Math.round(t + h / 2), 0, frame.height - 1);
      } else {
        if (!vision) throw new Error('文字模式仅支持按识别目标点击。');
        x = px(a.x, frame.width); y = px(a.y, frame.height);
      }
      action = { type: 'tap', x, y };
      break;
    }
    case 'swipe':
      if (!vision) throw new Error('滑动需要截图视觉模式。');
      action = { type: 'swipe', x: px(a.x, frame.width), y: px(a.y, frame.height),
        x2: px(a.x2, frame.width), y2: px(a.y2, frame.height), ms: integer(a.ms, 100, 2000) };
      break;
    case 'back': action = { type: 'back' }; break;
    case 'wait': action = { type: 'wait', ms: integer(a.ms, 300, 30000) }; break;
    default: throw new Error('模型返回了不支持的动作。');
  }
  return { ...decision, action };
}

export async function runAgent({ config, device, instruction, history, readOnly, limit, signal, emit,
  runNative, guidance, lookupGuide,
  observe = recognize, plan = decide, matches = stillMatches, pause = (ms, s) => delay(ms, undefined, { signal: s }) }) {
  const steps = [];
  const completedTasks = new Set();
  let staleCount = 0, actionCount = 0, previousInput, identicalInputs = 0;
  const recent = () => steps.length <= 18 ? steps : [...steps.slice(0, 3), ...steps.slice(-15)];
  for (let turn = 1; ; turn++) {
    signal.throwIfAborted();
    emit({ type: 'status', text: '正在识别游戏画面', turn });
    const frame = await observe(await device.capture(signal), signal);
    signal.throwIfAborted();
    emit({ type: 'frame', preview: frame.preview, width: frame.width, height: frame.height,
      recognition: frame.recognition, anchors: frame.anchors, client: frame.client, turn });
    emit({ type: 'status', text: '等待模型判断', turn });
    const context = { instruction, conversation: history, turn, stepsSoFar: actionCount,
      remainingActions: limit - actionCount, readOnly, recentSteps: recent(), maaAvailable: !!runNative, guidance };
    const decision = validateDecision(await plan(config, context, frame, signal), frame, readOnly, config.vision, !!runNative, !!guidance?.plan);
    signal.throwIfAborted();
    const { action, note, goal } = decision;
    if (endTypes.has(action.type)) {
      emit({ type: 'end', outcome: action.type, note, goal, count: actionCount });
      return;
    }
    if (actionCount >= limit) throw new Error('已达到本次动作上限，目标尚未确认完成。');
    emit({ type: 'decision', action, note, goal, turn });
    if (['find_guide','load_guide'].includes(action.type)) {
      const result = await lookupGuide(action);
      steps.push({turn,action,note,result});
      actionCount++;
      emit({type:'applied',turn,action});
      continue;
    }
    if (action.type === 'maa') {
      const key = JSON.stringify(action);
      if (completedTasks.has(key)) throw new Error('本条指令已执行过该 Maa 任务，已停止重复执行。');
      await runNative(action);
      completedTasks.add(key);
    } else if (action.type === 'wait') {
      await pause(action.ms, signal);
    } else {
      const current = await device.capture(signal);
      if (!matches(frame, current, action)) {
        staleCount++;
        emit({ type: 'stale', text: '画面已变化，跳过本次输入并重新判断。', turn });
        steps.push({ turn, action, note, result: '已跳过，画面变化' });
        if (staleCount >= 3) throw new Error('画面连续变化，无法确定输入目标。');
        continue;
      }
      staleCount = 0;
      const signature = JSON.stringify(action);
      identicalInputs = previousInput?.signature === signature && frame.png.equals(previousInput.png) ? identicalInputs + 1 : 0;
      if (identicalInputs >= 2) throw new Error('连续两次相同输入后画面仍未变化，已停止重复操作。');
      signal.throwIfAborted();
      await device.input(action, signal);
      previousInput = { signature, png: frame.png };
    }
    actionCount++;
    steps.push({ turn, action, note, result: action.type === 'maa' ? 'Maa 任务链已结束，请核对结果' : action.type === 'wait' ? '已等待' : '已发送，需查看下一帧' });
    emit({ type: 'applied', turn, action });
    if (action.type !== 'wait') await pause(800, signal);
  }
}
