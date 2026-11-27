import { publicJson } from './guides.mjs';
import { characters } from './roster.mjs';

const tableBase = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/';
const sourceBase = 'https://github.com/Kengxxiao/ArknightsGameData/blob/master/zh_CN/gamedata/excel/';
const cache = new Map();

async function table(name, signal) {
  const cached = cache.get(name);
  if (cached && Date.now() < cached.expires) return cached.data;
  const data = await publicJson(tableBase + name + '.json', signal, {}, 40 * 1024 * 1024);
  cache.set(name, {data, expires: Date.now() + 3600000});
  return data;
}

export function matchRewards(query, stages, campaigns = {}) {
  const name = query.trim().toUpperCase();
  return Object.values(stages).filter(stage =>
    [stage.code, stage.name, stage.stageId].some(value => value?.trim().toUpperCase() === name)
  ).map(stage => {
    const row = {code: stage.code, name: stage.name?.trim(), stageId: stage.stageId,
      difficulty: stage.difficulty, diffGroup: stage.diffGroup, firstClearOriginite: stage.diamondOnceDrop,
      storyOnly: !!stage.isStoryOnly};
    const campaign = campaigns[stage.stageId];
    if (campaign) row.firstKillOrundum = campaign.breakLadders.flatMap(tier => {
      const amount = tier.rewards.filter(item => item.id === '4003').reduce((n, item) => n + item.count, 0);
      return amount ? [{kills: tier.killCnt, amount}] : [];
    });
    return row;
  });
}

export async function stageRewards(query, signal) {
  const stages = (await table('stage_table', signal)).stages;
  const matches = matchRewards(query, stages);
  const sources = ['stage_table'];
  if (matches.some(row => stages[row.stageId].stageType === 'CAMPAIGN')) {
    sources.push('campaign_table');
    const {campaigns} = await table('campaign_table', signal);
    return {rows: matchRewards(query, stages, campaigns), sources: sources.map(sourceLink)};
  }
  if (!matches.length) {
    const handbook = await table('handbook_info_table', signal);
    const {characters: operators} = await characters();
    return {rows: matchSimulations(query, handbook.handbookStageData, operators),
      sources: ['stage_table','handbook_info_table'].map(sourceLink)};
  }
  return {rows: matches, sources: sources.map(sourceLink)};
}

export function matchChapterRewards(query, stageTable, zones, archive, activities, now) {
  const input = query.trim();
  const episode = /^(?:EP\s*(\d+)|第\s*(\d+)\s*章)$/i.exec(input);
  const mainZone = episode && Object.values(zones).find(zone =>
    ['MAINLINE','MAINLINE_ACTIVITY'].includes(zone.type) && /^\d+$/.test(zone.zoneNameTitleCurrent) &&
    Number(zone.zoneNameTitleCurrent) === Number(episode[1] || episode[2]));
  const name = mainZone?.zoneNameSecond || input;
  const entries = new Map();
  const add = stage => { if (stage.diamondOnceDrop > 0) entries.set(stage.stageId, stage); };
  const isAvailable = window => !window || window.startTs <= now && (window.endTs < 0 || now < window.endTs);
  for (const stage of Object.values(stageTable.stages)) {
    const zone = zones[stage.zoneId];
    const basic = activities.basicInfo[activities.zoneToActivity[stage.zoneId]];
    if (!isAvailable(stageTable.stageValidInfo?.[stage.stageId])) continue;
    if (zone?.zoneNameSecond === name &&
        (zone.type === 'MAINLINE' && ['MAIN','SUB'].includes(stage.stageType) || stage.stageType === 'DAILY')) add(stage);
    if (basic?.name === name && basic.startTime <= now && now < basic.endTime &&
        (stage.stageType === 'ACTIVITY' || zone?.type === 'MAINLINE_ACTIVITY')) add(stage);
  }
  for (const stage of Object.values(archive.stageList)) {
    const series = archive.retroActList[archive.zoneToRetro[stage.zoneId]];
    const window = archive.stageValidInfo[stage.stageId];
    if (series?.name === name && series.startTime <= now && isAvailable(window)) add(stage);
  }
  if (!entries.size) return {chapter:name, found:false};
  const byMode = new Map();
  let firstClearOriginite = 0;
  for (const stage of entries.values()) {
    let mode = {FOUR_STAR:'突袭／遭遇', SIX_STAR:'险地作战'}[stage.difficulty];
    if (!mode) mode = {TOUGH:'磨难险地', NORMAL:'标准实战'}[stage.diffGroup] || '普通';
    if (stage.isStoryOnly) mode = '剧情';
    if (!byMode.has(mode)) byMode.set(mode, {mode, codes:[], firstClearOriginite:0});
    const entry = byMode.get(mode);
    entry.codes.push(stage.code);
    entry.firstClearOriginite += stage.diamondOnceDrop;
    firstClearOriginite += stage.diamondOnceDrop;
  }
  return {chapter:name, found:true, firstClearOriginite, modes:[...byMode.values()], accountStatus:'需据实机勋标、领奖状态或前置进度核对'};
}

export async function chapterRewards(query, signal) {
  const names = ['stage_table','zone_table','retro_table','activity_table'];
  const [stage, zone, archive, activity] = await Promise.all(names.map(name => table(name, signal)));
  return {...matchChapterRewards(query, stage, zone.zones, archive, activity, Date.now()/1000), sources:names.map(sourceLink)};
}

export async function archiveStage(code, signal) {
  const archive = await table('retro_table',signal);
  const matches = Object.values(archive.stageList).filter(stage=>stage.code===code && stage.difficulty==='NORMAL');
  if (matches.length !== 1) throw new Error('未找到唯一的常驻活动普通关卡 '+code+'。');
  const [stage] = matches;
  const chapter = archive.retroActList[archive.zoneToRetro[stage.zoneId]];
  if (!chapter || chapter.startTime>Date.now()/1000) throw new Error('这项活动尚未收录。');
  const englishTitle = chapter.retroId.replace(/^permanent_(?:sub|main|sidestory)_\d+_/,'').replaceAll('_',' ');
  // The catalog uses illustrated logos. Its detail panel also prints the public chapter synopsis.
  let description = '';
  try {
    const {storylineStorySets} = await table('stage_table',signal);
    description = Object.values(storylineStorySets || {}).find(row=>
      chapter.linkedActId?.includes(row.relevantActivityId) && row.ssData?.desc)?.ssData.desc || '';
  } catch { signal?.throwIfAborted(); }
  return {code,chapter:chapter.name,englishTitle,name:stage.name,description};
}

export function matchSimulations(query, stages, operators) {
  const key = query.trim().toUpperCase();
  const names = new Map(operators.map(operator => [operator.id,operator.name]));
  return Object.values(stages).filter(stage =>
    [stage.stageId, stage.name, stage.charId, names.get(stage.charId)].some(value => value?.toUpperCase() === key)
  ).map(stage => ({stageId: stage.stageId, name: stage.name, operator: names.get(stage.charId) || stage.charId,
    firstClearOrundum: stage.rewardItem.filter(item => item.id === '4003').reduce((n,item) => n + item.count,0)}));
}

function sourceLink(name) {
  return {title: '国服游戏数据 · ' + name, url: sourceBase + name + '.json'};
}
