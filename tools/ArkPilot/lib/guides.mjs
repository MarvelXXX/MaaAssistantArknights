import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const resource = process.env.ARK_MAA_RESOURCE || fileURLToPath(new URL('../../../resource/', import.meta.url));
const station = 'https://prts.maa.plus/copilot/';
const idPattern = /^[1-9]\d{0,9}$/;
const biliHeaders = {Referer:'https://www.bilibili.com/', 'User-Agent':'Mozilla/5.0 ArkPilot'};
const streamCache = new Map();
const actionTypes = new Set(('Deploy Skill Retreat SpeedUp BulletTime SkillUsage Output SkillDaemon MoveCamera ResetStopwatch Click Swipe SetUnitLocation ' +
  '部署 技能 撤退 二倍速 子弹时间 技能用法 打印 摆完挂机 移动镜头 重置全局计时器 点击 滑动 设置单位坐标').split(' '));

export function checkPlan(plan) {
  if (!plan || typeof plan !== 'object' || typeof plan.stage_name !== 'string' || !plan.stage_name.trim() ||
      plan.stage_name.length > 150 || !Array.isArray(plan.actions) || !plan.actions.length ||
      plan.actions.length > 1000 || Buffer.byteLength(JSON.stringify(plan)) > 160000) {
    throw new Error('需要普通战斗作业 JSON，包含 stage_name 和非空 actions。');
  }
  const isOp = o => !!o && typeof o.name === 'string' && o.name.trim().length > 0;
  if ((plan.opers != null && (!Array.isArray(plan.opers) || !plan.opers.every(isOp))) ||
      (plan.groups != null && (!Array.isArray(plan.groups) || !plan.groups.every(g => isOp(g) && Array.isArray(g.opers) && g.opers.every(isOp)))) ||
      (plan.doc?.details != null && typeof plan.doc.details !== 'string') ||
      (plan.doc?.title != null && typeof plan.doc.title !== 'string')) throw new Error('作业编队或说明格式有误。');
  for (const [i, a] of plan.actions.entries()) {
    const type = a?.type ?? 'Deploy';
    if (!a || typeof a !== 'object' || !actionTypes.has(type)) throw new Error('第 ' + (i+1) + ' 步动作不受支持。');
    if (['Deploy','部署'].includes(type) && (typeof a.name !== 'string' || !a.name.trim() ||
        !Array.isArray(a.location) || a.location.length !== 2 || !a.location.every(n => Number.isInteger(n) && n >= 0) ||
        !['Left','Right','Up','Down','None','左','右','上','下','无'].includes(a.direction))) {
      throw new Error('第 ' + (i+1) + ' 步部署缺少干员、棋盘坐标或朝向。');
    }
  }
  return plan;
}

let overview;
async function stageAliases(query) {
  const text = String(query || '').trim();
  if (!text || text.length > 100) throw new Error('请输入关卡编号或名称。');
  overview ??= readFile(path.join(resource, 'Arknights-Tile-Pos', 'overview.json'), 'utf8')
    .then(json => Object.values(JSON.parse(json))).catch(() => []);
  const same = value => typeof value === 'string' && value.toLowerCase() === text.toLowerCase();
  const rows = (await overview).filter(s => [s.code,s.name,s.stageId,s.levelId].some(same));
  const row = rows.find(s => !s.stageId.includes('#')) || rows[0];
  const id = row?.stageId || text;
  const searchIds = [id, ...rows.filter(s => same(s.name) && !s.stageId.includes('#')).map(s => s.stageId)];
  return {id, row, searchIds:[...new Set(searchIds)], aliases:[text, ...rows.flatMap(s => [s.stageId,s.code,s.name,s.levelId])].map(s => s.toLowerCase())};
}

export async function stageBoard(stage) {
  const {row} = await stageAliases(stage);
  if (!row) return null;
  const map = JSON.parse(await readFile(path.join(resource,'Arknights-Tile-Pos',row.filename),'utf8'));
  return {tiles:map.tiles.map(row=>row.map(tile=>tile.buildableType)),terrain:map.tiles.map(row=>row.map(tile=>tile.tileKey))};
}

export async function paradoxStageId(plan) {
  if (!plan) return null;
  const {row} = await stageAliases(plan.stage_name);
  return row?.levelId.startsWith('obt/memory/') ? row.stageId : null;
}

export async function matchesRewardStage(plan, stageId) {
  if (!plan) return false;
  const {row} = await stageAliases(stageId);
  if (!row) return plan.stage_name.toLowerCase() === stageId.toLowerCase();
  const {row:actual} = await stageAliases(plan.stage_name);
  if (!actual) return false;
  return actual.stageId === row.stageId || actual.levelId === row.levelId;
}

// Project the tile in the tilted deployment view, as in Arknights-Tile-Pos/TileCalc2.hpp.
export async function deploymentTarget(stage, location, width, height) {
  const {row} = await stageAliases(stage);
  if (!row || Math.abs(width / height - 16 / 9) > 0.04) throw new Error('缺少本关的 16:9 部署地图。');
  const map = JSON.parse(await readFile(path.join(resource,'Arknights-Tile-Pos',row.filename),'utf8'));
  const [col, line] = location;
  const tile = map.tiles[line]?.[col];
  if (!tile?.buildableType) throw new Error('所选格不可部署。');
  const [cx, cy, cz] = map.view[1];
  const x = col - (map.width - 1) / 2 - cx;
  const y = (map.height - 1) / 2 - line - cy;
  const z = -0.4 * tile.heightType - cz;
  const rad = Math.PI / 180;
  const rotatedX = Math.cos(10 * rad) * x + Math.sin(10 * rad) * z;
  const rotatedZ = -Math.sin(10 * rad) * x + Math.cos(10 * rad) * z;
  const rotatedY = Math.cos(30 * rad) * y - Math.sin(30 * rad) * rotatedZ;
  const depth = Math.sin(30 * rad) * y + Math.cos(30 * rad) * rotatedZ;
  const scale = height / (2 * Math.tan(20 * rad) * depth);
  const point = {x:Math.round(width / 2 + rotatedX * scale),y:Math.round(height / 2 - rotatedY * scale)};
  if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) throw new Error('部署格超出当前画面。');
  return point;
}

export async function publicJson(url, signal, headers = {}, maxBytes = 4 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(18000)]), headers, redirect:'error' })
    .catch(() => { signal.throwIfAborted(); throw new Error('攻略站连接失败，请稍后重试或导入本地文件。'); });
  if (!response.ok) { await response.body?.cancel(); throw new Error('攻略站返回 HTTP ' + response.status + '。'); }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('攻略站响应过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function searchGuides(query, signal, videoCode = '', includeVideos = false, checkRoster) {
  if (videoCode && !/^BV[a-zA-Z0-9]{10}$/.test(videoCode)) throw new Error('视频编号无效。');
  const {searchIds, aliases} = await stageAliases(query);
  const matches = new Map();
  for (const id of searchIds) {
    const url = new URL('query', station);
    const limit = checkRoster ? '100' : videoCode ? '50' : '20';
    url.search = new URLSearchParams({page:'1', limit, orderBy:'views', desc:'true', levelKeyword:id});
    const reply = await publicJson(url, signal);
    if (reply.status_code !== 200 || !Array.isArray(reply.data?.data)) throw new Error('作业站搜索失败。');
    for (const item of reply.data.data) {
      try {
        const plan = JSON.parse(item.content);
        if (!idPattern.test(String(item.id)) || !aliases.includes(plan.stage_name.toLowerCase())) continue;
        if (videoCode && !(String(plan.doc?.details || '') + ' ' + String(plan.doc?.title || '')).includes(videoCode)) continue;
        const row = { id: String(item.id), title: String(plan.doc?.title || plan.stage_name).slice(0,150) };
        if (checkRoster && (plan.opers?.length || plan.groups?.length)) Object.assign(row,checkRoster(plan));
        if (includeVideos) row.videos = [...new Set(String(plan.doc?.details || '').match(/BV[a-zA-Z0-9]{10}/g) || [])].slice(0,3);
        if (searchIds.length > 1) row.stage = plan.stage_name;
        matches.set(row.id,row);
      } catch { continue; }
    }
  }
  const rows = [...matches.values()];
  if (checkRoster) {
    const unresolved = row => row.unconfirmedSlots?.length ?? Number.MAX_SAFE_INTEGER;
    rows.sort((a,b)=>unresolved(a)-unresolved(b) ||
      (b.leastTrained?.elite ?? -1)-(a.leastTrained?.elite ?? -1) || (b.leastTrained?.level ?? -1)-(a.leastTrained?.level ?? -1));
  }
  return rows;
}

function planId(value) {
  if (idPattern.test(value)) return value;
  return value.match(/^(?:maa|prts):\/\/([1-9]\d{0,9})\/?$/i)?.[1] ||
    value.match(/^https:\/\/prts\.plus\/(?:copilot|plan)\/([1-9]\d{0,9})(?:[/?#].*)?$/i)?.[1];
}

export function briefPlan(plan) {
  return plan && {stage:plan.stage_name,title:plan.doc?.title,opers:plan.opers?.slice(0,24),groups:plan.groups?.map(g => g.name).slice(0,24),
    groupChoices:plan.groups?.slice(0,24).map(g=>({name:g.name,opers:g.opers.slice(0,24).map(({name,skill})=>({name,skill}))})),
    actionCount:plan.actions.length,actionsTruncated:plan.actions.length > 24,firstActions:plan.actions.slice(0,24)};
}

async function biliInfo(bv, part, signal) {
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bv) || !Number.isInteger(part) || part < 1 || part > 1000) throw new Error('BV 号或分 P 无效。');
  const reply = await publicJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bv,signal,biliHeaders);
  const page = reply.data?.pages?.[part-1];
  if (reply.code !== 0 || !page?.cid) throw new Error('无法读取该分 P 的公开视频，可选择本地文件。');
  return {detail:reply.data,page};
}

export async function openBiliMedia(bv, part, signal, range) {
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bv) || !Number.isInteger(part) || part < 1 || part > 1000 ||
      (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw new Error('视频请求格式无效。');
  const key = bv + '/' + part;
  let entry = streamCache.get(key);
  if (!entry || entry.until < Date.now()) {
    const {page} = await biliInfo(bv,part,signal);
    const url = new URL('https://api.bilibili.com/x/player/playurl');
    url.search = new URLSearchParams({bvid:bv,cid:String(page.cid),qn:'64',fnval:'1',platform:'html5'});
    const reply = await publicJson(url,signal,biliHeaders);
    const file = reply.data?.durl?.[0];
    if (reply.code !== 0 || !/^mp4(?:\d{3,4})?$/.test(reply.data?.format || '') ||
        reply.data?.durl?.length !== 1 || !file?.url || file.size > 1024**3) {
      throw new Error('该视频未提供可读取的单段公开 MP4，或超过 1 GiB。可选择本地录像。');
    }
    const cdn = new URL(file.url);
    if (cdn.protocol !== 'https:' || cdn.username || cdn.password || !/(^|\.)bilivideo\.(com|cn)$/.test(cdn.hostname)) {
      throw new Error('此播放源暂不支持，请选择本地录像。');
    }
    if (streamCache.size >= 16) streamCache.delete(streamCache.keys().next().value);
    entry = {url:cdn.href,until:Date.now()+120000}; streamCache.set(key,entry);
  }
  const response = await fetch(entry.url,{headers:{...biliHeaders,...(range ? {Range:range} : {})},signal,redirect:'error'});
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 1024**3) {
    await response.body?.cancel(); streamCache.delete(key); throw new Error('视频平台未提供可读的公开媒体流，请使用本地文件。');
  }
  return response;
}

export async function importGuide(value, signal) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入作业码、作业 JSON 或 B 站视频地址。');
  const input = value.trim();
  if (input.startsWith('{')) {
    let plan;
    try { plan = JSON.parse(input); } catch { throw new Error('作业 JSON 格式有误。'); }
    return { plan: checkPlan(plan), source: '本地 JSON' };
  }
  const id = planId(input);
  if (id) {
    const reply = await publicJson(station + 'get/' + id, signal);
    if (reply.status_code !== 200 || !reply.data?.content) throw new Error('作业不存在或暂不可用。');
    return { plan: checkPlan(JSON.parse(reply.data.content)), source: 'PRTS #' + id, link: 'https://prts.plus/copilot/' + id };
  }
  const bv = input.match(/^(?:https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/)?(BV[a-zA-Z0-9]{10})(?:[/?#].*)?$/)?.[1];
  if (!bv) throw new Error('支持 maa://作业号、PRTS 单份作业链接、JSON、B 站 BV 号或完整视频链接。');
  const part = /^https?:/i.test(input) ? Number(new URL(input).searchParams.get('p') || 1) : 1;
  const {detail,page} = await biliInfo(bv,part,signal);
  const notes = ('视频标题：' + detail.title + '\n简介：' + (detail.desc || '无')).slice(0,6000);
  const code = String(detail.desc || '').match(/(?:maa|prts):\/\/[1-9]\d{0,9}|https:\/\/prts\.plus\/(?:copilot|plan)\/[1-9]\d{0,9}/i)?.[0];
  const stageHint = String(detail.title).match(/(?:[A-Z]{1,5}(?:-[A-Z]+)?|\d{1,2})-\d{1,2}(?!\d)/i)?.[0] || '';
  return { notes, source:'B 站视频简介', link:'https://www.bilibili.com/video/' + bv + '?p=' + part, code, video:{bv,part,duration:page.duration}, stageHint };
}
