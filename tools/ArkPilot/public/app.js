import { setupGuides } from './guides.js';
const $ = id => document.getElementById(id);
const storeKey = 'arkpilot.settings.v1';
let saved;
try { saved = JSON.parse(localStorage.getItem(storeKey)) || {}; } catch { saved = {}; }
let config = { url: saved.url || '', model: saved.model || '', key: '', vision: saved.vision !== false, limit: saved.limit || 24 };
let controller = null;
let previewController = null;
let deviceGeneration = 0;
const history = [];
$('mode').value = saved.researchOnly ? 'research' : saved.readOnly ? 'inspect' : 'operate';
function persist() {
  // The API key and conversational content only live in this tab's memory.
  saved = { url: config.url, model: config.model, vision: config.vision, limit: config.limit,
    serial: $('device').value || saved.serial, readOnly: $('mode').value === 'inspect',researchOnly:$('mode').value === 'research' };
  try { localStorage.setItem(storeKey, JSON.stringify(saved)); } catch {}
}
function modelStatus() {
  $('modelLight').textContent = config.url ? '模型已配置' : '模型待配置';
  $('modelLight').classList.toggle('ready', !!config.url);
  $('modelLight').title = config.model || '';
}
async function post(route, data, signal) {
  const res = await fetch('/api/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal,
  });
  if (!res.ok) throw new Error((await res.json()).error || '请求失败。');
  return res;
}
function configMessage(text, error = false) {
  $('configStatus').textContent = text;
  $('configStatus').classList.toggle('error-text', error);
}
function openSettings(text = '') {
  $('url').value = config.url; $('model').value = config.model; $('key').value = config.key;
  $('inputMode').value = config.vision ? 'vision' : 'text'; $('limit').value = String(config.limit);
  $('fetchedModels').hidden = true;
  configMessage(text);
  $('settings').showModal();
}
function formConfig() {
  return { url: $('url').value.trim(), model: $('model').value.trim(), key: $('key').value.trim(),
    vision: $('inputMode').value === 'vision', limit: Number($('limit').value) };
}
$('settingsBtn').onclick = () => openSettings();
$('closeSettings').onclick = () => $('settings').close();
$('settings').addEventListener('close', () => { $('key').value = ''; });
$('configForm').onsubmit = event => {
  event.preventDefault();
  const draft = formConfig();
  if (draft.url) {
    const url = new URL(draft.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      return configMessage('请填写 HTTP(S) 模型接口，密钥放入 API Key 字段。', true);
    }
  }
  config = draft; persist(); modelStatus(); $('settings').close(); $('instruction').focus();
};
$('getModels').onclick = async () => {
  const button = $('getModels');
  button.disabled = true; configMessage('正在读取模型列表…');
  try {
    const { models } = await (await post('models', formConfig())).json();
    $('modelOptions').replaceChildren(...models.map(id => new Option(id, id)));
    $('fetchedModels').replaceChildren(new Option('选择可用模型…', ''), ...models.map(id => new Option(id, id)));
    $('fetchedModels').hidden = models.length < 2;
    if (models.length === 1) $('model').value = models[0];
    configMessage(models.length ? '已获取 ' + models.length + ' 个模型。' : '列表为空，可手动填写模型 ID。');
  } catch (err) { configMessage(err.message, true); }
  finally { button.disabled = false; }
};
$('fetchedModels').onchange = () => { if ($('fetchedModels').value) $('model').value = $('fetchedModels').value; };
$('url').oninput = () => { $('fetchedModels').hidden = true; $('modelOptions').replaceChildren(); };

function noScreen(hint) {
  $('screen').hidden = true; $('screen').removeAttribute('src');
  $('screenHint').hidden = false; $('screenHint').textContent = hint;
  $('resolution').textContent = '— × —'; $('frameTime').textContent = '尚未截图';
  $('targets').replaceChildren(); $('targetCount').textContent = '0';
  $('recognitionStatus').textContent = '获取画面后显示识别来源。';
}
function showFrame(frame) {
  $('screen').src = frame.preview; $('screen').hidden = false; $('screenHint').hidden = true;
  $('resolution').textContent = frame.width + ' × ' + frame.height;
  $('frameTime').textContent = '采集于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  $('recognitionStatus').textContent = frame.recognition.join(' · ');
  $('targetCount').textContent = frame.anchors.length;
  $('targets').replaceChildren(...frame.anchors.map(item => {
    const li = document.createElement('li');
    li.textContent = item.source + ' · ' + item.label + (item.score ? ' (' + Math.round(item.score * 100) + '%)' : '');
    return li;
  }));
}
async function refreshPreview() {
  previewController?.abort();
  if ($('mode').value === 'research') { noScreen('仅查攻略模式可在模拟器关闭时使用。'); return; }
  const serial = $('device').value;
  if (!serial) { noScreen('在连接设置中添加设备，或检查 ADB 调试是否开启。'); return; }
  const local = new AbortController();
  previewController = local; $('refreshFrame').disabled = true;
  try {
    const frame = await (await post('preview', { serial }, local.signal)).json();
    if (!local.signal.aborted && serial === $('device').value) showFrame(frame);
  } catch (err) { if (!local.signal.aborted) noScreen(err.message); }
  finally { if (previewController === local) { previewController = null; $('refreshFrame').disabled = !!controller; } }
}
async function scanDevices(address) {
  const generation = ++deviceGeneration;
  try {
    const reply = await post(address ? 'connect' : 'devices', address ? { address } : {});
    const { devices } = await reply.json();
    if (generation !== deviceGeneration) return;
    const preferred = address || $('device').value || saved.serial;
    const online = devices.filter(d => d.state === 'device');
    $('device').replaceChildren(...devices.map(d => {
      const line = [d.serial, d.model || '', d.state === 'device' ? '' : d.state].filter(Boolean).join(' · ');
      const option = new Option(line, d.serial); option.disabled = d.state !== 'device'; return option;
    }));
    if (!online.length) $('device').prepend(new Option('暂无在线设备', ''));
    $('device').value = online.find(d => d.serial === preferred)?.serial || online[0]?.serial || '';
    configMessage('检测到 ' + online.length + ' 个在线 ADB 连接。');
    await refreshPreview();
  } catch (err) {
    if (generation !== deviceGeneration) return;
    configMessage(err.message, true);
    if (!address) { $('device').replaceChildren(new Option('检测失败', '')); noScreen(err.message); }
  }
}
$('scan').onclick = () => scanDevices();
$('connect').onclick = () => {
  const address = $('address').value.trim();
  if (address) scanDevices(address); else configMessage('请先填写 ADB 连接地址。', true);
};
$('device').onchange = () => { persist(); noScreen('正在读取设备…'); refreshPreview(); };
$('mode').onchange = () => { persist(); refreshPreview(); };
$('refreshFrame').onclick = refreshPreview;

function message(role, text, error = false) {
  $('welcome').hidden = true;
  const box = document.createElement('article'); box.className = 'message ' + role + (error ? ' error' : '');
  const who = document.createElement('div'); who.className = 'who'; who.textContent = role === 'user' ? '你' : 'ArkPilot';
  const content = document.createElement('div'); content.className = 'content'; content.textContent = text;
  box.append(who, content); $('feed').append(box); $('feed').scrollTop = $('feed').scrollHeight;
  return content;
}
function busy(value) {
  for (const id of ['device','mode','settingsBtn','libraryBtn','attachment','refreshFrame','clear']) $(id).disabled = value;
  $('clear').disabled = value || !history.length;
  $('send').hidden = value; $('stop').hidden = !value;
}
function addStep(text) {
  const li = document.createElement('li'); li.textContent = text; $('steps').append(li);
  const status = document.createElement('span'); status.className = 'step-result'; li.append(status);
  return status;
}
function actionName(a) {
  switch (a.type) {
    case 'maa': return 'Maa · ' + a.task + (a.stage ? ' ' + a.stage + ' × ' + a.times : '');
    case 'find_guide': return '搜索 ' + a.stage + ' 作业';
    case 'stage_rewards': return '核对关卡奖励 · ' + a.stage;
    case 'load_guide': return '导入作业 #' + a.id;
    case 'search_web': return '联网搜索 · '+a.query;
    case 'read_wiki': return '阅读 PRTS Wiki · '+a.title;
    case 'analyze_video': return '解读视频画面 · '+a.bv+' P'+a.part;
    case 'adapt_guide': return '按名册适配部署';
    case 'tap': return '点击 (' + a.x + ', ' + a.y + ')';
    case 'swipe': return '滑动 (' + a.x + ', ' + a.y + ') → (' + a.x2 + ', ' + a.y2 + ')';
    case 'back': return '返回';
    case 'wait': return '等待 ' + a.ms / 1000 + ' 秒';
  }
}
async function* events(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + value).split('\n'); rest = lines.pop();
      for (const line of lines) if (line.trim()) yield JSON.parse(line);
    }
    if (rest.trim()) yield JSON.parse(rest);
  } finally { reader.releaseLock(); }
}
async function submit(event, native = null, label = '') {
  event?.preventDefault();
  const instruction = label || $('instruction').value.trim();
  if (!instruction || controller) return;
  if (!native && !config.url) { openSettings('填写模型服务地址后即可发送这条指令。'); return; }
  const serial = $('device').value;
  const researchOnly = $('mode').value === 'research';
  if (!serial && !researchOnly) { openSettings('操作游戏需要连接设备，查攻略可选择“仅查攻略”。'); return; }
  const local = new AbortController(); controller = local;
  previewController?.abort();
  const previous = history.filter(m => m.serial === serial).slice(-12).map(({ role, text }) => ({ role, text }));
  history.push({ role: 'user', text: instruction, serial }); message('user', instruction);
  const reply = message('assistant', '正在连接…');
  $('steps').replaceChildren(); $('idle').hidden = true; if (!native) $('instruction').value = '';
  busy(true);
  let end = false, step, applied = [];
  try {
    const res = await post('run', { ...(native ? {} : config), ...guides.current(), native, serial, instruction, history: previous,
      researchOnly,readOnly: $('mode').value !== 'operate' }, local.signal);
    for await (const e of events(res)) {
      if (e.type === 'frame') showFrame(e);
      else if (e.type === 'guide_loaded') guides.render(e);
      else if (e.type === 'sources' || e.type === 'video_notes') {
        const hits = e.results || [{title:e.clip.bv+' P'+e.clip.part+' · '+e.clip.timestamps.length+' 帧',url:e.clip.url}];
        if (e.notes) guides.attachNotes(e.notes);
        for (const hit of hits) {
          if (!/^https?:\/\//.test(hit.url)) continue;
          const li = document.createElement('li'), a = document.createElement('a');
          a.className='guide-link'; a.href=hit.url; a.target='_blank'; a.rel='noopener noreferrer';
          a.textContent=(hit.source ? hit.source+' · ' : '')+hit.title; li.append(a); $('steps').append(li);
        }
      }
      else if (e.type === 'research_error') { if (step) step.textContent = e.text; else addStep(e.text); }
      else if (e.type === 'guide_search') { $('stageSearch').value = e.stage; $('stageSearch').oninput(); guides.showResults(e.results); }
      else if (e.type === 'model') $('modelLight').title = e.model;
      else if (e.type === 'core') { reply.textContent = 'Maa · ' + e.text; if (step) step.textContent = reply.textContent; }
      else if (e.type === 'status') reply.textContent = '第 ' + e.turn + ' 次观察 · ' + e.text;
      else if (e.type === 'decision') {
        reply.textContent = e.goal + '\n' + e.note;
        step = addStep(e.note); step.textContent = '待执行 · ' + actionName(e.action);
      } else if (e.type === 'applied') {
        applied.push(actionName(e.action)); if (step) step.textContent = '已执行 · ' + applied.at(-1);
      } else if (e.type === 'stale') { if (step) step.textContent = e.text; }
      else if (e.type === 'error') throw new Error(e.text);
      else if (e.type === 'end') {
        reply.textContent = e.note;
        addStep(({ finish: '已完成', ask: '等待补充', stop: '已停止' })[e.outcome]).textContent = e.goal;
        history.push({ role: 'assistant', text: e.note, serial }); end = true;
      }
      $('feed').scrollTop = $('feed').scrollHeight;
    }
    if (!end) throw new Error('连接中断，任务结果未确认。');
  } catch (err) {
    const text = local.signal.aborted ? '已停止。' : err.message;
    reply.textContent = text; reply.parentElement.classList.add('error');
    addStep(text); history.push({ role: 'assistant', text: text + (applied.length ? ' 已执行：' + applied.join('、') : ''), serial });
  } finally {
    controller = null; busy(false); $('instruction').focus();
    if (native) refreshPreview();
  }
}
$('compose').onsubmit = submit;
$('stop').onclick = () => controller?.abort();
$('instruction').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault(); $('compose').requestSubmit();
  }
};
$('clear').onclick = () => {
  history.length = 0; $('feed').querySelectorAll('article').forEach(node => node.remove());
  $('welcome').hidden = false; $('steps').replaceChildren(); $('idle').hidden = false; busy(false);
};
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.onclick = () => { $('instruction').value = button.dataset.prompt; $('instruction').focus(); };
});
const guides = setupGuides({post,events,getConfig:() => config,runDirect:(a,label) => submit(null,a,label)});
modelStatus();
scanDevices();
