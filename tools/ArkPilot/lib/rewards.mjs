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
