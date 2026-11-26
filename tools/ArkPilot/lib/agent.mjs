import { setTimeout as delay } from 'node:timers/promises';
import { hasFacingPrompt, intelBalanceCrop, intelShopStock, isPracticeFormation, recognize, sameReadyOperator, stillMatches } from './vision.mjs';
import { deploymentTarget } from './guides.mjs';
import { decide } from './model.mjs';
import { nativeAction } from './maa.mjs';

const endTypes = new Set(['finish', 'ask', 'stop']);
const researchTools = new Set(['find_guide','load_guide','adapt_guide','search_web','read_wiki','analyze_video','stage_rewards','chapter_rewards','roguelike_placements']);
const noPremiumSpend = /(?:禁止|不得|不能|不可|不要|不许|不准|不|别)(?:再|额外)?(?:消耗|花费|使用|花|用|动用)[^，。；;\n]{0,16}(?:源石|合成玉)|(?:源石|合成玉)[^，。；;\n]{0,12}(?:不能|不可|不许|禁止|不)(?:花|用|消耗)|(?:do not|don't|never)\s+(?:use|spend)\s+(?:any\s+)?(?:originite|orundum)/iu;
export function requestsPracticeOnly(instruction) {
  if (!/演习|演练|\b(?:practice|rehearsal)\b/iu.test(instruction)) return false;
  return !/(?:无需|不用|跳过|略过|不要)(?:再|再次)?(?:演习|演练)|(?:然后|随后|之后|再|直接|改为|改打|转入)(?:打|进行|开始)?正式(?:作战|战斗|挑战|开战|首通)?|(?:then|followed by)\s+(?:a\s+)?(?:real|normal|live)\s+(?:run|battle)/iu.test(instruction);
}

function premiumConfirmation(frame) {
  const labels = frame.anchors.map(anchor => anchor.label || '');
  if (frame.anchors.some(anchor => anchor.source === 'Maa' && anchor.label === '源石恢复提示')) return true;
  const text = labels.join('').replace(/\s/g, '');
  return /(?:是否|确认|确定)(?:要|将|继续)?(?:花费|消耗|使用|用)[^。！？]{0,24}(?:源石|合成玉)|(?:是否|确认|确定)[^。！？]{0,12}源石[^。！？]{0,12}兑换[^。！？]{0,12}合成玉/u.test(text);
}

function battleResult(frame) {
  return frame.anchors?.some(({label}) =>
    /^(行动结束|演习结束|行动結束|演習結束|结算[二三]星标志|磨难结算标志|MISSIONRESULTS)$/i.test(label?.replace(/\s/g,'')));
}

function requestsBaseInspection(text) {
  return /基建|贸易站|制造站/.test(text) && /只读|只(?:看|查看|核查)|仅(?:看|查看|核查)|(?:查看|核对|检查)[^。]{0,48}(?:不要|不准|禁止|不得)(?:交付|收取|收货)/.test(text);
}

function gameStartTap(frame, action) {
  if (action.type !== 'tap' || !frame.image ||
      !['com.hypergryph.arknights','com.hypergryph.arknights.bilibili'].includes(frame.client)) return false;
  const header = frame.anchors.filter(a => a.source === 'OCR' && a.box?.[1] < frame.height * 0.12);
  if (!['清除缓存','网络检测'].every(label => header.some(a => a.label === label))) return false;
  const icon = frame.anchors.find(a => a.source === 'Maa' && a.label === '启动页 START' && a.score >= 0.94);
  if (!icon) return false;
  const [x, y, width, height] = icon.box;
  if (action.x < x || action.x >= x + width || action.y < y || action.y >= y + height) return false;
  let yellow = 0, samples = 0;
  for (let row = y; row < y + height; row += 3) {
    for (let col = x; col < x + width; col += 3) {
      const i = (row * frame.width + col) * 4;
      const data = frame.image.data;
      if (data[i] > 195 && data[i+1] > 150 && data[i+2] < 90) yellow++;
      samples++;
    }
  }
  return yellow > samples * 0.12;
}

export function baseInspectionInput(frame, action) {
  if (action.type==='back' || action.type==='wait' || endTypes.has(action.type) || researchTools.has(action.type)) return true;
  const labels=frame.anchors.map(a=>(a.label || '').replace(/\s/g,''));
  const x=action.x/frame.width, y=action.y/frame.height;
  const atLabel = pattern => frame.anchors.some((a,i)=>a.box && pattern.test(labels[i]) &&
    action.x>=a.box[0]-2 && action.x<=a.box[0]+a.box[2]+2 && action.y>=a.box[1]-2 && action.y<=a.box[1]+a.box[3]+2);
  if (action.type!=='tap') return false;
  // The CN base exit dialog uses an unlabelled checkmark in the red footer.
  const exiting = frame.anchors.some((a,i)=>a.source==='OCR' && a.box &&
    /^是否确认离开罗德岛基建[?？]?$/.test(labels[i]) &&
    a.box[0]<frame.width/2 && a.box[0]+a.box[2]>frame.width/2 &&
    a.box[1]>frame.height*0.36 && a.box[1]<frame.height*0.46);
  if (exiting) return Math.abs(frame.width/frame.height-16/9)<0.015 &&
    x>0.55 && x<0.91 && y>0.64 && y<0.73;
  const home=labels.includes('主界面设置入口');
  if (home) return (x>0.64 && y>0.77 && y<0.98 && atLabel(/基建|仓库/)) ||
    (x>0.72 && x<0.81 && y>0.80 && y<0.88);
  if (atLabel(/^(?:取消|返回|首页)$/)) return true;
  const overview=labels.some(s=>s.includes('进驻总览') || s.includes('建造模式'));
  if (overview) {
    // The whole room card can instantly deliver an order even when the tap hits its name.
    return x<0.2 && y<0.225 && atLabel(/^进驻总览$/) ||
      Math.abs(frame.width/frame.height-16/9)<0.015 && x>0.18 && x<0.24 && y>0.025 && y<0.085;
  }
  if (atLabel(/^(?:基础物品|养成材料|消耗物品)$/) && labels.includes('仓库')) return true;
  const room=labels.some(s=>/(?:贸易站|制造站)B\d{3}|龙门商法|开采协力/.test(s));
  return room && x<0.19 && atLabel(/^(?:设施信息|进驻信息|(?:贸易站)?B\d{3}|\d{2}贸易站)$/);
}

// Sample the purple RE ticket on the 16:9 CN shop layout. Both price lines must show it.
function hasIntelTicket(image, left, top, width, height) {
  if (!image || Math.abs(image.width / image.height - 16 / 9) > 0.015) return false;
  function purple(x,y) {
    const col = Math.floor((left + x*width)*image.width/1440);
    const row = Math.floor((top + y*height)*image.height/810);
    const i = 4*(row*image.width+col);
    const [r,g,b] = image.data.subarray(i,i+3);
    return r>80 && b-r>35 && b-g>38;
  }
  return [[0.15,0.46],[0.45,0.46],[0.75,0.46],[0.75,0.61],[0.75,0.78]].every(([x,y])=>purple(x,y)) &&
    !purple(0.65,0.12) && !purple(0.85,0.12);
}

export function intelCheckout(frame, action, order, submitted) {
  if (!['tap','swipe','deploy','maa'].includes(action.type)) return false;
  const labels = frame.anchors.map(a=>a.label.replace(/\s/g,''));
  const x = action.x/frame.width, y = action.y/frame.height;
  const button = frame.anchors.some(a=>/购买物品/.test(a.label) && a.box &&
    action.x>=a.box[0] && action.x<=a.box[0]+a.box[2] && action.y>=a.box[1] && action.y<=a.box[1]+a.box[3]);
  const inButton = x>=0.62 && x<=0.815 && y>=0.765 && y<=0.85;
  const checkout = labels.some(s=>/购买物品|购买数量|总计支付/.test(s));
  if (!checkout && labels.some(s=>/^(?:确定|确认|确认购买|立即购买|支付)$/.test(s)) && !labels.includes('获得物资')) {
    throw new Error('情报凭证任务遇到无法核实付款币种的确认框。');
  }
  if (!button && !inButton) return false;
  if (!checkout && labels.includes('获得物资')) return false;
  const {lots,tickets,stock} = order;
  const exact = ['购买数量','总计支付'+(20*lots),'购买物品'];
  if (action.type!=='tap' || submitted || order.auditOnly || !inButton || !exact.every(s=>labels.includes(s)) ||
      !intelShopStock(frame,tickets,stock) || !labels.some(s=>/^[x×]100$/i.test(s)) ||
      !hasIntelTicket(frame.image,1019,224,28,40) || !hasIntelTicket(frame.image,1036,568,19,27)) {
    throw new Error('情报凭证付款核验未通过，未提交购买。');
  }
  return true;
}
// An explicit request for a runnable adaptation is fulfilled by the attached plan.
// Explanations, hypothetical questions and prohibitions stay with the planner.
function wantsAdaptedPlan(text) {
  if (!/(?:名册|适配|替补|替换|我的干员|my roster|substitut)/iu.test(text)) return false;
  if (/(?:不要|不用|无需|别|暂缓|暂不|不必)[^，,。；;\n]{0,6}(?:适配|改编|生成|替换)|(?:如何|能否|是否|怎么|支持吗).{0,8}(?:生成|适配)|(?:do not|don't)\s+(?:adapt|generate)/iu.test(text)) return false;
  return /(?:生成|做成|改成|附上|附为|附到).{0,16}(?:适配|替补|可执行|作业|部署方案)|(?:按|用).{0,16}(?:名册|我的干员).{0,12}(?:适配|改阵容)|(?:adapt|generate).{0,25}(?:my roster|copilot plan)/iu.test(text);
}
const shortText = (v,max = 100) => typeof v === 'string' && v.trim() && v.length <= max;
class InvalidInput extends Error {}
function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new InvalidInput('动作参数必须是 '+min+' 至 '+max+' 之间的整数。');
  return value;
}

export function validateDecision(reply, frame, readOnly, vision, maaAvailable = false, hasPlan = false) {
  if (!reply || !['inspect', 'operate'].includes(reply.intent) || typeof reply.goal !== 'string' ||
      !reply.goal.trim() || typeof reply.note !== 'string' || !reply.note.trim() ||
      !reply.action || typeof reply.action !== 'object') throw new Error('模型决策缺少意图、说明或动作。');
  const a = reply.action;
  const decision = { intent: reply.intent, goal: reply.goal.slice(0, 300), note: reply.note.slice(0, 4000) };
  if (endTypes.has(a.type)) return { ...decision, action: { type: a.type } };
  if (a.type === 'adapt_guide') return {...decision,action:{type:a.type}};
  if (a.type === 'search_web' && shortText(a.query,160) && (a.stage == null || shortText(a.stage))) {
    return {...decision,action:{type:a.type,query:a.query.trim(),stage:a.stage?.trim()}};
  }
  if (a.type === 'read_wiki' && shortText(a.title) && (a.section == null || shortText(a.section,60))) {
    return {...decision,action:{type:a.type,title:a.title.trim(),section:a.section?.trim()}};
  }
  if (a.type === 'analyze_video' && /^BV[a-zA-Z0-9]{10}$/.test(a.bv) && (a.stage == null || shortText(a.stage))) {
    const part = a.part == null ? undefined : integer(a.part,1,1000);
    if ([a.start,a.end].some(n => n != null && (!Number.isFinite(n) || n < 0 || n > 86400)) ||
        (a.end != null && a.end <= (a.start ?? 0))) throw new Error('视频片段时间无效。');
    return {...decision,action:{type:a.type,bv:a.bv,part,stage:a.stage?.trim(),start:a.start,end:a.end}};
  }
  if (['find_guide','stage_rewards','chapter_rewards','roguelike_placements'].includes(a.type) && shortText(a.stage)) {
    return {...decision, action:{type:a.type,stage:a.stage.trim()}};
  }
  if (a.type === 'load_guide' && typeof a.id === 'string' && /^[1-9]\d{0,9}$/.test(a.id)) {
    return {...decision, action:{type:a.type,id:a.id}};
  }
  if (researchTools.has(a.type)) throw new Error('资料工具 ' + a.type + ' 的参数无效。');
  if (readOnly) throw new Error('只读分析收到了操作指令，已停止。');
  if (reply.intent === 'inspect') throw new InvalidInput('只读意图不能执行游戏输入。请按本轮用户要求重新选择动作和意图。');
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
        if (!target) throw new InvalidInput('模型选取的目标不在当前识别结果中。');
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
    case 'deploy':
      if (!vision || !hasPlan) throw new InvalidInput('部署需要截图和已附的本关作业。');
      action = {type:'deploy',step:integer(a.step,1,24),x:px(a.x,frame.width),y:px(a.y,frame.height)};
      if (action.y < frame.height * 0.78) throw new InvalidInput('请从战斗底部实际出现的待部署卡拖动。');
      break;
    case 'back': action = { type: 'back' }; break;
    case 'wait': action = { type: 'wait', ms: integer(a.ms, 300, 30000) }; break;
    default: throw new Error('模型返回了不支持的动作。');
  }
  return { ...decision, action };
}

function hasBattlefieldHud(frame) {
  const anchors = frame.anchors;
  if (anchors.some(a=>/剩余可放置|可放置角色|UnitLimit/i.test(a.label.replace(/\s/g,'')))) return true;
  const native = new Set(anchors.filter(a=>a.source==='Maa').map(a=>a.label));
  const kills = anchors.some(a=>a.box && a.box[1]<frame.height*0.1 &&
    a.box[0]>frame.width*0.28 && a.box[0]<frame.width*0.6 && /^\d{1,3}[/／]\d{1,3}$/.test(a.label.replace(/\s/g,'')));
  return native.has('战斗部署费用图标') && (kills || native.has('战斗防御点图标')) ||
    native.has('战斗防御点图标') && kills;
}

async function deployFromGuide(action, guide, frame, device, signal, pause) {
  const order = guide.firstActions?.[action.step - 1];
  if (!order || !['Deploy','部署'].includes(order.type ?? 'Deploy')) throw new InvalidInput('附件中这一步不是部署，请核对作业步骤。');
  if (!hasBattlefieldHud(frame)) throw new InvalidInput('本帧未确认战斗部署栏，未拖卡。请观察新画面和高亮提示。');
  const target = await deploymentTarget(guide.stage,order.location,frame.width,frame.height);
  await device.input({type:'swipe',x:action.x,y:action.y,x2:target.x,y2:target.y,ms:450},signal);
  if (['None','无'].includes(order.direction)) return true;

  await pause(280,signal);
  if (!hasFacingPrompt(frame,await device.capture(signal),target)) return false;
  const vectors = {Right:[1,0],右:[1,0],Left:[-1,0],左:[-1,0],Up:[0,-1],上:[0,-1],Down:[0,1],下:[0,1]};
  const [dx,dy] = vectors[order.direction];
  const distance = Math.round(frame.height * 0.18);
  await device.input({type:'swipe',...target,x2:Math.max(0,Math.min(frame.width-1,target.x+dx*distance)),
    y2:Math.max(0,Math.min(frame.height-1,target.y+dy*distance)),ms:260},signal);
  return true;
}

export async function runAgent({ config, device, instruction, history, readOnly, limit, signal, emit, practiceOnly = requestsPracticeOnly(instruction),
  runNative, guidance, lookupGuide, continueBattle, intelExchange, inspectBase=requestsBaseInspection(instruction), retryModel = false, requireAdaptation = wantsAdaptedPlan(instruction),
  observe = recognize, plan = decide, matches = stillMatches, pause = (ms, s) => delay(ms, undefined, { signal: s }) }) {
  const steps = [];
  const attemptedTasks = new Set();
  const protectsCurrency = practiceOnly || noPremiumSpend.test(instruction);
  let submittedExchange = false;
  let afterNativeBattle = false, settledResult = false;
  async function waitForRating(turn) {
    emit({type:'status',text:'等待结算动画结束，再核对最终评价',turn});
    await pause(4500, signal);
    signal.throwIfAborted();
  }
  let blockedBaseInputs=0;
  async function observeGame(raw) {
    const frame=await observe(raw,signal);
    const crop=intelExchange && intelBalanceCrop(frame);
    if (!crop) return frame;
    const read=await plan({...config,toolsUnsupported:true},{
      instruction:'这是游戏商店右上角当前凭证余额的独立放大图。只读这串白色数字，斜杠穿过的椭圆是数字0。看清全部数字时，finish 的 note 只写完整整数，看不清则写读数失败。',
      readOnly:true,turn:1,recentSteps:[],conversation:[],remainingActions:0,
    },{width:crop.width,height:crop.height,preview:crop.preview,anchors:[]},signal);
    const label=read.note?.trim();
    if (read.action?.type==='finish' && /^\d+$/.test(label) && label.length===crop.digits) {
      return {...frame,anchors:[...frame.anchors,{source:'凭证读数',label,box:crop.box,id:frame.anchors.length+1}]};
    }
    return frame;
  }
  let adaptation, rejectedInput, modelRetries = 0;
  let staleCount = 0, actionCount = 0, previousInput, identicalInputs = 0;
  const recent = () => steps.length <= 18 ? steps : [...steps.slice(0, 3), ...steps.slice(-15)];
  for (let turn = 1; ; turn++) {
    signal.throwIfAborted();
    let frame = {anchors:[],recognition:'仅查攻略，无游戏画面'};
    if (device) {
      emit({ type: 'status', text: '正在识别游戏画面', turn });
      if (afterNativeBattle) await waitForRating(turn);
      frame = await observeGame(await device.capture(signal));
      // The result heading and outlines appear before all earned stars light up.
      if (!settledResult && battleResult(frame)) {
        await waitForRating(turn);
        frame = await observeGame(await device.capture(signal));
      }
      settledResult = battleResult(frame);
      afterNativeBattle = false;
    }
    signal.throwIfAborted();
    if (device) emit({ type: 'frame', preview: frame.preview, width: frame.width, height: frame.height,
      recognition: frame.recognition, anchors: frame.anchors, client: frame.client, turn });
    emit({ type: 'status', text: '等待模型判断', turn });
    const context = { instruction, conversation: history, turn, stepsSoFar: actionCount,
      remainingActions: limit - actionCount, readOnly, recentSteps: recent(), maaAvailable: !!runNative, guidance };
    if (steps.length > 18) {
      context.earlierObservations = steps.slice(3,-15).map(step => ({
        turn: step.turn, action: step.action.type, note: step.note.slice(0,320),
        result: typeof step.result === 'string' ? step.result : step.result?.error || '已查资料',
      }));
    }
    if (inspectBase) context.baseInspection='基建只查看。进驻总览里的整张房间卡片可能直接收货，请用 back 退出说明、总览和基建。仅当弹窗明确询问是否确认离开罗德岛基建时，点击右侧勾选按钮返回首页。不可点房间卡片或通知。';
    if (rejectedInput) context.rejectedInput = rejectedInput;
    let reply;
    try { reply = await plan(config, context, frame, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (!retryModel || error.code!=='MODEL_TEMPORARY' || modelRetries>=2) throw error;
      const seconds = Math.max([10,30][modelRetries++],Math.ceil((error.retryAfterMs || 0)/1000));
      emit({type:'status',text:'模型连接暂时中断，'+seconds+' 秒后重新观察当前画面。',turn});
      await pause(seconds*1000,signal);
      continue;
    }
    modelRetries=0;
    let decision;
    try {
      decision = validateDecision(reply, frame, readOnly, config.vision, !!runNative, !!guidance?.plan);
    } catch (error) {
      if (!(error instanceof InvalidInput) || rejectedInput) throw error;
      rejectedInput = error.message;
      emit({type:'status',text:'动作参数校验失败，未执行。正在重新识别并规划。',turn});
      continue;
    }
    rejectedInput = undefined;
    signal.throwIfAborted();
    if (decision.action.type === 'finish' && requireAdaptation && guidance?.roster && guidance.plan) {
      if (!adaptation) decision = {...decision,intent:'inspect',note:'正在生成并校验所要求的替补作业。',action:{type:'adapt_guide'}};
      else if (!adaptation.ready) decision = {...decision,note:adaptation.reason || adaptation.error || '未生成适配作业。',action:{type:'ask'}};
    }
    const { action, note, goal } = decision;
    if (practiceOnly && action.type==='tap' && action.x>frame.width*0.77 && action.x<frame.width*0.96 && action.y>frame.height*0.44 && action.y<frame.height*0.97 &&
        frame.anchors.some(a=>a.label==='编队页开始行动' || /快捷编队|QUICK FORMATION/i.test(a.label)) && !isPracticeFormation(frame)) {
      steps.push({turn,action,note,result:'当前编队缺少演习 PLAN 标志。回关卡详情点演习，再从蓝色 PLAN 编队页执行作业。'});
      emit({type:'stale',text:'已拦截普通编队页的开始行动。',turn});
      actionCount++;
      continue;
    }
    if (protectsCurrency && ['tap','swipe','deploy','maa'].includes(action.type) && premiumConfirmation(frame)) {
      emit({type:'end', outcome:'stop', goal, count:actionCount,
        note:'识别到源石恢复或货币消费确认界面，已按本轮禁用货币的要求停止输入。'});
      return;
    }
    if (endTypes.has(action.type)) {
      emit({ type: 'end', outcome: action.type, note, goal, count: actionCount });
      return;
    }
    if (actionCount >= limit) throw new Error('已达到本次动作上限，目标尚未确认完成。');
    if (inspectBase && !baseInspectionInput(frame,action)) {
      const reason='只读基建已拦截该区域。可查看进驻总览，用 back 返回，并在离开罗德岛基建提示中点击右侧勾选按钮。';
      steps.push({turn,action,note,result:reason});
      emit({type:'stale',text:reason,turn});
      if (++blockedBaseInputs>=3) {emit({type:'end',outcome:'stop',goal,count:actionCount,note:reason});return;}
      continue;
    }
    const buying = intelExchange && intelCheckout(frame,action,intelExchange,submittedExchange);
    emit({ type: 'decision', action, note, goal, turn });
    if (researchTools.has(action.type)) {
      let result;
      try { result = await lookupGuide(action,{width:frame.width,height:frame.height}); }
      catch (err) { signal.throwIfAborted(); result = {error:err.message}; emit({type:'research_error',text:err.message}); }
      if (action.type === 'load_guide' && !result?.error) adaptation = null;
      if (action.type === 'adapt_guide') adaptation = result;
      const executed = action.type === 'analyze_video' && Number.isInteger(result?.part)
        ? {...action,part:result.part} : action;
      steps.push({turn,action:executed,note,result});
      actionCount++;
      if (!result?.error) emit({type:'applied',turn,action:executed});
      continue;
    }
    let nativeReport;
    if (action.type === 'maa') {
      const key = ['Copilot','ParadoxCopilot'].includes(action.task)
        ? JSON.stringify(['guide', guidance.plan.stage]) : JSON.stringify(action);
      if (attemptedTasks.has(key)) throw new Error('本条指令已尝试该 Maa 任务，已停止重复执行。');
      attemptedTasks.add(key);
      try {
        afterNativeBattle = ['Fight','Copilot','ParadoxCopilot'].includes(action.task);
        nativeReport = await runNative(action);
      } catch (error) {
        signal.throwIfAborted();
        if (error.beforeStart) {
          afterNativeBattle = false;
          attemptedTasks.delete(key);
        }
        const reason = (error.beforeStart ? 'Maa 尚未开战。' : 'Maa 未确认完成。') + error.message;
        steps.push({turn,action,note,result:reason});
        emit({type:'research_error',text:reason,turn});
        actionCount++;
        continue;
      }
    } else if (action.type === 'wait') {
      await pause(action.ms, signal);
    } else {
      const current = await device.capture(signal);
      if (!matches(frame, current, action) && !await sameReadyOperator(frame,current,action) &&
          !(frame.client === current.client && frame.width === current.width && frame.height === current.height &&
            gameStartTap(frame, action) && gameStartTap(await observe(current, signal), action))) {
        staleCount++;
        emit({ type: 'stale', text: '画面已变化，跳过本次输入并重新判断。', turn });
        steps.push({ turn, action, note, result: '画面已变化，本次输入未发送。请根据新截图重新选择稳定的目标。' });
        if (staleCount >= 3) throw new Error('画面连续变化，无法确定输入目标。');
        continue;
      }
      if (inspectBase && action.type==='tap' && !baseInspectionInput(await observe(current,signal),action)) {
        throw new Error('基建只读导航目标已变化，未发送点击。');
      }
      staleCount = 0;
      const signature = JSON.stringify(action);
      identicalInputs = previousInput?.signature === signature && frame.png.equals(previousInput.png) ? identicalInputs + 1 : 0;
      if (identicalInputs >= 2) throw new Error('连续两次相同输入后画面仍未变化，已停止重复操作。');
      signal.throwIfAborted();
      if (action.type === 'deploy') {
        let placed;
        try { placed = await deployFromGuide(action,guidance.plan,frame,device,signal,pause); }
        catch (error) {
          if (!(error instanceof InvalidInput)) throw error;
          steps.push({turn,action,note,result:error.message});
          emit({type:'stale',text:error.message,turn});
          actionCount++;
          continue;
        }
        if (!placed) {
          steps.push({turn,action,note,result:'已拖卡，未确认朝向框，请观察新画面再操作。'});
          emit({type:'stale',text:'已拖卡，等待核对朝向框。',turn});
          actionCount++;
          continue;
        }
      } else {
        if (buying) {
          const fresh = await observeGame(current);
          if (!intelCheckout(fresh,action,intelExchange,submittedExchange) || premiumConfirmation(fresh)) {
            throw new Error('购买前的实时凭证或价格已变化，已停止输入。');
          }
          signal.throwIfAborted();
          submittedExchange = true;
        }
        await device.input(action, signal);
      }
      previousInput = { signature, png: frame.png };
    }
    actionCount++;
    steps.push({ turn, action, note, result: action.type === 'maa' ? nativeReport || 'Maa 任务链已结束，请核对结果' : action.type === 'wait' ? '已等待' : '已发送，需查看下一帧' });
    emit({ type: 'applied', turn, action });
    if (action.type==='deploy' && continueBattle) {
      try {
        const result = await continueBattle(action.step);
        if (result) steps.push({turn,action,note,result});
      } catch (error) {
        signal.throwIfAborted();
        steps.push({turn,action,note,result:'续打尚未确认完成，请从当前战场继续。'+error.message});
        emit({type:'research_error',text:'续打已交回视觉操作。'+error.message,turn});
      }
    }
    if (action.type !== 'wait') await pause(800, signal);
  }
}
