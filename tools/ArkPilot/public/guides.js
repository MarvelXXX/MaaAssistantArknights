const $ = id => document.getElementById(id);
const verbs = {Deploy:'部署', Skill:'开技能', Retreat:'撤退', SpeedUp:'切换倍速', BulletTime:'子弹时间',
  SkillUsage:'设置技能用法', SkillDaemon:'挂机至结束', Output:'提示', MoveCamera:'移动镜头'};
const dirs = {Left:'左',Right:'右',Up:'上',Down:'下',None:'无'};
function actionText(a) {
  const type = a.type || 'Deploy';
  const parts = [verbs[type] || type,a.name,a.location && '(' + a.location.join(', ') + ')',
    a.direction && '朝' + (dirs[a.direction] || a.direction)];
  for (const [key,label] of [['kills','击杀数'],['costs','费用'],['cost_changes','费用变化'],['pre_delay','前置毫秒'],['post_delay','后置毫秒']]) {
    if (a[key] != null) parts.push(label + ' ' + a[key]);
  }
  return parts.filter(Boolean).join(' · ');
}

function seek(video, seconds, signal) {
  return new Promise((resolve,reject) => {
    let timeout;
    function finish(error) {
      clearTimeout(timeout);
      video.removeEventListener('seeked',ready); video.removeEventListener('error',bad);
      signal.removeEventListener('abort',cancel);
      if (error) reject(error); else resolve();
    }
    const ready = () => finish();
    const bad = () => finish(new Error('浏览器无法解码该视频。'));
    const cancel = () => finish(signal.reason);
    if (signal.aborted) return cancel();
    if (Math.abs(video.currentTime-seconds) < 0.001 && video.readyState >= 2) return ready();
    video.addEventListener('seeked',ready); video.addEventListener('error',bad);
    signal.addEventListener('abort',cancel,{once:true});
    timeout = setTimeout(bad,10000);
    video.currentTime = seconds;
  });
}

async function clipFrames(video, signal) {
  if (!Number.isFinite(video.duration) || !video.videoWidth) throw new Error('请等待视频载入，或选择浏览器支持的 MP4/WebM 文件。');
  const start = Number($('clipStart').value), end = Math.min(video.duration, Number($('clipEnd').value));
  if (!(start >= 0 && end > start)) throw new Error('结束时间须大于起始时间，并位于视频范围内。');
  video.pause();
  const count = Math.min(12,Math.max(2,Math.ceil((end-start)/2)));
  const canvas = document.createElement('canvas');
  const scale = Math.min(1,960/Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1,Math.round(video.videoWidth*scale)); canvas.height = Math.max(1,Math.round(video.videoHeight*scale));
  const ctx = canvas.getContext('2d'), frames = [];
  for (let i = 0; i < count; i++) {
    const seconds = start+(i+0.5)*(end-start)/count;
    await seek(video,seconds,signal);
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    frames.push({seconds,image:canvas.toDataURL('image/jpeg',0.75)});
  }
  return frames;
}

export function mergeRosterScan(previous, scan) {
  const saved = new Map((previous?.operators || []).map(op=>[op.id,op]));
  const operators = scan.operators.map(op=>{
    const merged = {...saved.get(op.id),...op};
    saved.delete(op.id);
    return merged;
  });
  if (!scan.complete) operators.push(...saved.values());
  return {...scan,operators};
}

export function setupGuides({post,events,getConfig,runDirect}) {
  let plan = null, source = '', mediaUrl = '', pending = null, relatedVideo = null, onlineVideo = null, recentSearch = [];
  let beforeAdapt = null;
  const profiles = new Map();
  try { for (const [name,value] of JSON.parse(localStorage.getItem('arkpilot.rosters') || '[]')) profiles.set(name,value); } catch {}
  function profileMenu(name) {
    $('accountProfile').replaceChildren(new Option('未选择名册',''),...[...profiles.keys()].map(n=>new Option(n,n)));
    $('accountProfile').value = name && profiles.has(name) ? name : '';
    const profile = profiles.get($('accountProfile').value);
    $('accountInfo').textContent = profile ? profile.roster.operators.length+' 条记录 · '+profile.updated : '可扫描、导入或手动填写后保存。';
    $('boxData').value = profile ? JSON.stringify({operators:profile.roster.operators},null,2) : '';
    $('boxComplete').checked = profile?.roster.complete === true;
    $('profileName').value = '';
    localStorage.setItem('arkpilot.activeRoster',$('accountProfile').value);
  }
  profileMenu(localStorage.getItem('arkpilot.activeRoster'));
  $('accountProfile').onchange = () => profileMenu($('accountProfile').value);
  const currentRoster = () => profiles.get($('accountProfile').value)?.roster || null;
  function saveRoster(data,name) {
    const operators = data.operators.map(({tokens,position,role,rarity,branch,rangeIds,...record})=>record);
    profiles.set(name,{roster:{complete:data.complete,operators},updated:new Date().toLocaleString()});
    localStorage.setItem('arkpilot.rosters',JSON.stringify([...profiles]));
    profileMenu(name);
  }
  const dialog = $('library');
  const status = (text, error = false) => { $('guideStatus').textContent = text; $('guideStatus').classList.toggle('error-text',error); };
  const request = async (route,data,signal) => (await post(route,data,signal)).json();
  function attachment() {
    const label = plan ? plan.stage_name : $('guideNotes').value.trim() ? '文字笔记' : '';
    $('attachment').hidden = !label;
    $('attachment').textContent = '已附攻略 · ' + label;
  }
  function render(result) {
    if (result.ready && result.plan) beforeAdapt ??= plan && {plan,source,notes:$('guideNotes').value,formation:$('formation').checked};
    else beforeAdapt = null;
    $('undoAdapt').hidden = !beforeAdapt;
    $('adaptSummary').textContent = result.ready ? [result.reason,...(result.changes || [])].join(' · ') : '';
    if (result.ready) $('formation').checked = true;
    else if (typeof result.formation === 'boolean') $('formation').checked = result.formation;
    plan = result.plan || null; source = result.source || '';
    $('guideNotes').value = (result.notes || plan?.doc?.details || '').slice(0,6000);
    const links = new Map();
    if (result.link && /^https:\/\/(?:prts\.plus|www\.bilibili\.com)\//.test(result.link)) links.set(result.link,'查看来源 ↗');
    const codes = $('guideNotes').value.match(/BV[a-zA-Z0-9]{10}/g) || [];
    for (const bv of codes) {
      links.set('https://www.bilibili.com/video/' + bv,'视频 ' + bv + ' ↗');
    }
    relatedVideo = result.video || (codes.length ? {bv:codes[0],part:1} : null);
    if (onlineVideo && (onlineVideo.bv !== relatedVideo?.bv || onlineVideo.part !== relatedVideo?.part)) {
      onlineVideo = null; setMedia('');
    }
    $('openOnline').hidden = !relatedVideo;
    $('searchVideoPlans').hidden = !relatedVideo;
    if (result.stageHint) { $('stageSearch').value = result.stageHint; $('stageSearch').oninput(); }
    $('guideLinks').replaceChildren(...[...links].slice(0,8).map(([url,label]) => {
      const a = document.createElement('a'); a.href = url; a.textContent = label; a.target = '_blank';
      a.className = 'guide-link'; a.rel = 'noopener noreferrer'; return a;
    }));
    $('planPreview').hidden = !plan;
    if (plan) {
      $('planTitle').textContent = plan.doc?.title || plan.stage_name;
      $('planMeta').textContent = source + ' · ' + plan.stage_name;
      const oper = o => o.name + (o.skill ? '（技能 ' + o.skill + '）' : '');
      const names = [...(plan.opers || []).map(oper), ...(plan.groups || []).map(g => g.name + '：' + g.opers.map(oper).join(' / '))];
      $('operators').textContent = names.length ? '编队 · ' + names.join('，') : '作业未指定编队';
      $('actionSummary').textContent = '查看 ' + plan.actions.length + ' 步作业动作';
      $('planActions').replaceChildren(...plan.actions.map(a => {
        const li = document.createElement('li'); li.textContent = actionText(a); return li;
      }));
    }
    attachment();
  }
  function showSections() {
    const type = $('libraryType').value;
    for (const tab of ['plan','video','daily','roster']) $(tab+'Section').hidden = tab !== type;
    const references = type === 'plan' || type === 'video';
    $('referenceSection').hidden = !references;
    $('onlineSource').hidden = !references;
    $('planPreview').hidden = !plan || !references;
  }
  async function job(label, fn) {
    if (pending) return;
    const local = new AbortController(); pending = local;
    const controls = [...dialog.querySelectorAll('button,input,select,textarea')].filter(el => !['cancelGuide','closeLibrary'].includes(el.id));
    controls.forEach(el => el.disabled = true);
    $('cancelGuide').hidden = false; status(label);
    try { await fn(local.signal); }
    catch (err) { status(local.signal.aborted ? '已停止处理。' : err.message,true); }
    finally {
      controls.forEach(el => el.disabled = false);
      $('cancelGuide').hidden = true; pending = null;
    }
  }
  function open() {
    showSections(); dialog.showModal();
    request('maa',{}).then(r => { $('coreStatus').textContent = r.home ? '已检测到 MaaCore · ' + r.home : '未找到 Maa 运行包。可用 ARK_MAA_HOME 指定包含 MaaCore.dll 的目录。'; })
      .catch(e => { $('coreStatus').textContent = e.message; });
  }
  $('libraryBtn').onclick = $('attachment').onclick = open;
  $('libraryType').onchange = showSections;
  const profileName = () => $('profileName').value.trim() || $('accountProfile').value || '我的账号';
  $('maaBoxFile').onclick = () => job('正在读取 Maa 的本机名册…',async signal=>{
    const roster = await request('roster/maa-file',{},signal);
    saveRoster(roster,profileName()); status('已导入 '+roster.operators.length+' 条记录'+(roster.syncTime ? '，Maa 同步时间 '+roster.syncTime : '')+'。');
  });
  $('saveBox').onclick = () => job('正在核对干员…',async signal=>{
    const raw = JSON.parse($('boxData').value);
    saveRoster(await request('roster/import',{...raw,complete:$('boxComplete').checked},signal),profileName());
    status('已保存名册，可在战斗作业中适配部署。');
  });
  $('boxFile').onchange = () => job('正在读取名册…',async signal=>{
    const file = $('boxFile').files[0]; if (!file) return;
    $('boxFile').value = '';
    if (file.size > 1024**2) throw new Error('请选择 1 MiB 以内的名册 JSON。');
    const raw = JSON.parse(await file.text());
    const roster = await request('roster/import',{operators:raw.operators ?? raw.own_opers,complete:raw.complete === true},signal);
    saveRoster(roster,profileName()); status('已导入名册。');
  });
  $('scanBox').onclick = () => job('Maa 正在翻页识别干员…',async signal=>{
    const name = profileName();
    const roster = await request('roster/scan',{serial:$('device').value,readOnly:$('mode').value !== 'operate'},signal);
    const merged = mergeRosterScan(profiles.get(name)?.roster,roster);
    saveRoster(merged,name);
    status('本次识别 '+roster.operators.length+' 条，账号名册已保存 '+merged.operators.length+' 条。');
  });
  $('adaptPlan').onclick = () => job('正在核对练度并生成替补部署…',async signal=>{
    if (!currentRoster()) { $('libraryType').value='roster'; showSections(); throw new Error('请先扫描或导入当前账号的干员。'); }
    const notes = $('guideNotes').value;
    const result = await request('guides/adapt',{...getConfig(),guide:plan,roster:currentRoster(),notes},signal);
    if (!result.ready) { status(result.reason,true); return; }
    render({...result,notes:(result.reason+'\n'+notes).slice(0,6000)}); status('已更新待执行作业，可查看部署步骤或恢复原作业。');
  });
  $('undoAdapt').onclick = () => { if (beforeAdapt) render(beforeAdapt); status('已恢复原作业。'); };
  $('cancelGuide').onclick = () => pending?.abort();
  dialog.onclose = () => pending?.abort();
  $('useGuide').onclick = $('closeLibrary').onclick = () => dialog.close();
  $('clearGuide').onclick = () => { render({}); recentSearch = []; $('searchResults').replaceChildren(); $('recording').value = ''; setMedia(''); status('已清除当前攻略。'); };
  $('guideNotes').oninput = attachment;
  $('stageSearch').oninput = () => {
    const stage = $('stageSearch').value.trim();
    $('videoSearch').hidden = !stage;
    $('videoSearch').href = 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('明日方舟 ' + stage + ' 攻略');
  };
  function importValue(value) {
    return job('正在读取攻略…', async signal => {
      const result = await request('guides/import',{value},signal);
      render(result);
      if (result.code) { $('source').value = result.code; status('视频简介中找到了作业码 ' + result.code + '，点击导入即可查看作业。'); }
      else status(result.plan ? '作业已附给对话，可预览或直接执行。' : '已导入标题与简介。可查引用此 BV 的作业，或在视频攻略中读取公开视频画面。');
    });
  }
  function showResults(results) {
    recentSearch = results.slice(0,20);
    $('searchResults').replaceChildren(...results.map(r => {
      const button = document.createElement('button'); button.className = 'quiet';
      let label = '#' + r.id + ' · ' + r.title;
      if (r.unconfirmedSlots) label += r.unconfirmedSlots.length ? ' · 待核对 ' + r.unconfirmedSlots.join('、') : ' · 各编队位均有候选';
      if (r.leastTrained) label += ' · 最低 ' + r.leastTrained.name + ' 精' + r.leastTrained.elite + ' Lv.' + r.leastTrained.level;
      button.textContent = label; button.onclick = () => importValue(r.id); return button;
    }));
  }
  function search(videoCode) { return job('正在搜索 PRTS 作业…',async signal => {
    $('searchResults').replaceChildren();
    const {results} = await request('guides/search',{query:$('stageSearch').value,videoCode,roster:currentRoster()},signal);
    showResults(results);
    status(results.length ? '选择搜索结果以导入。' : videoCode ? '该关热门作业中未找到对此 BV 的引用。' : '未找到匹配关卡的作业，也可输入作业码。');
  }); }
  $('searchPlans').onclick = () => search('');
  $('searchVideoPlans').onclick = () => search(relatedVideo?.bv || '');
  $('importSource').onclick = () => importValue($('source').value);
  $('jsonFile').onchange = async () => {
    const file = $('jsonFile').files[0]; if (!file) return;
    try { if (file.size > 160000) throw new Error('请选择小于 160 KB 的作业 JSON。'); await importValue(await file.text()); }
    catch (err) { status(err.message,true); }
    $('jsonFile').value = '';
  };
  $('checkPlan').onclick = () => job('正在让 MaaCore 加载作业…', async signal => {
    const {version} = await request('guides/check',{guide:plan},signal);
    status('MaaCore ' + version + ' 已接受此作业。');
  });
  $('savePlan').onclick = () => {
    if (!plan) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(plan,null,2)],{type:'application/json'}));
    a.download = plan.stage_name.replace(/[^\w.-]/g,'_') + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href),1000);
  };
  function direct(a,label) {
    if ($('mode').value !== 'operate') { status('请先在指令台切换到允许操作。',true); return; }
    dialog.close(); runDirect(a,label);
  }
  $('runPlan').onclick = () => direct({task:'Copilot'},'执行已选作业 ' + plan.stage_name);
  $('runAward').onclick = () => direct({task:'Award'},'使用 Maa 领取日常奖励');
  $('runActivityOrundum').onclick = () => direct({task:'ActivityOrundum'},'/活动合成玉');
  $('runFarm').onclick = () => {
    const stage = $('farmStage').value.trim(), times = Number($('farmTimes').value);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(stage) || !Number.isInteger(times) || times < 1 || times > 100) return status('请填写关卡编号和 1–100 次代理次数。',true);
    direct({task:'Fight',stage,times},'代理 ' + stage + '，' + times + ' 次');
  };
  function setMedia(src) {
    const video = $('guideVideo');
    video.pause(); video.removeAttribute('src'); if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    mediaUrl = src?.startsWith('blob:') ? src : '';
    video.hidden = !src;
    if (!src) { video.load(); return; }
    video.onloadedmetadata = () => { $('clipStart').value = '0'; $('clipEnd').value = String(Math.min(30,video.duration)); };
    video.onerror = () => status('该视频源或编码无法在浏览器中播放。可改用本地文件。',true);
    video.src = src;
  }
  $('recording').onchange = () => {
    onlineVideo = null;
    const file = $('recording').files[0];
    setMedia(file ? URL.createObjectURL(file) : '');
  };
  $('openOnline').onclick = () => {
    onlineVideo = relatedVideo;
    $('recording').value = '';
    setMedia('/api/guides/media/' + onlineVideo.bv + '/' + onlineVideo.part);
    status('已选择公开视频 ' + onlineVideo.bv + ' · P' + onlineVideo.part);
  };
  $('readClip').onclick = () => job('正在采样视频画面…', async signal => {
    const config = getConfig();
    if (!config.url || !config.vision) throw new Error('请先在连接设置中配置支持图片输入的视觉模型。');
    const frames = await clipFrames($('guideVideo'),signal);
    status('正在请视觉模型解读 ' + frames.length + ' 帧…');
    const result = await request('guides/frames',{...config,frames},signal);
    const label = onlineVideo ? onlineVideo.bv + ' P' + onlineVideo.part : $('recording').files[0]?.name || '本地录像';
    const notes = (label + '\n' + result.notes).slice(0,6000);
    // Notes supplement the selected executable plan, without replacing its actions.
    if (plan) { $('guideNotes').value = notes; attachment(); }
    else render({...result,notes,video:onlineVideo});
    status('时间戳笔记已附给对话，可编辑。');
  });
  $('convertRecording').onclick = () => job('正在读取单场战斗录像…',async signal => {
    const file = $('recording').files[0];
    if (!onlineVideo && (!file || !file.size || file.size > 1024**3)) throw new Error('请先读取关联 B 站视频画面，或选择 1 GiB 以内的本地战斗录像。');
    const res = onlineVideo ? await post('guides/online-video',onlineVideo,signal) :
      await fetch('/api/guides/video', {method:'POST',headers:{'Content-Type':'application/octet-stream','X-Video-Ext':file.name.split('.').pop().toLowerCase()},body:file,signal});
    if (!res.ok) throw new Error((await res.json()).error || '录像处理失败。');
    let done = false;
    for await (const e of events(res)) {
      if (e.type === 'error') throw new Error(e.text);
      if (e.type === 'core') status('Maa 录像识别 · ' + e.text);
      if (e.type === 'guide') { render({...e,video:onlineVideo}); done = true; }
    }
    if (!done) throw new Error('未收到识别结果。');
    status('已生成作业草稿，请核对干员、坐标与触发条件。');
  });
  return {render, showResults, attachNotes:notes=>{ $('guideNotes').value=notes; attachment(); },
    current:() => ({guide:plan,roster:currentRoster(),notes:$('guideNotes').value.trim(),recentSearch,formation:$('formation').checked})};
}
