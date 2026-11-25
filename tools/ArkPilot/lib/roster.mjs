import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPlan, resource, stageBoard } from './guides.mjs';

let catalog;
const roleAliases = {vanguard:'pioneer',guard:'warrior',defender:'tank',supporter:'support',specialist:'special'};
export async function characters() {
  catalog ??= readFile(path.join(resource,'battle_data.json'),'utf8').then(s => {
    const {chars,ranges} = JSON.parse(s);
    return {ranges,characters:Object.entries(chars).filter(([id])=>id.startsWith('char_')).map(([id,c])=>({
      id,name:c.name,role:c.profession.toLowerCase(),branch:c.subProfessionId,position:c.position,rarity:c.rarity,tokens:c.tokens || [],rangeIds:c.rangeId,
    }))};
  });
  return catalog;
}
const bounds = {elite:[0,2],level:[1,90],skill_level:[1,7],module:[0,5],module_level:[1,3],potential:[1,6]};
function bounded(value,min,max) { return Number.isInteger(value) && value >= min && value <= max; }

export async function normalizeRoster(raw) {
  const rows = raw?.operators ?? raw?.own_opers;
  if (!Array.isArray(rows) || !rows.length || rows.length > 800) throw new Error('名册应含 1–800 条 operators 或 Maa own_opers 记录。');
  const {characters:chars} = await characters(), seen = new Set();
  const operators = rows.map(row => {
    if (!row || typeof row.name !== 'string' || row.name.length > 60) throw new Error('名册需要干员名。');
    const variants = chars.filter(c => row.id ? c.id === row.id : c.name === row.name.trim());
    if (variants.length !== 1) throw new Error('请核对干员名或提供职业形态的 id：' + row.name);
    const c = variants[0];
    if (seen.has(c.id)) throw new Error('名册重复：' + c.name);
    seen.add(c.id);
    const own = row.owned ?? row.own ?? true;
    if (typeof own !== 'boolean') throw new Error('owned 须为布尔值。');
    const op = {...c,owned:own};
    for (const [key,[min,max]] of Object.entries(bounds)) {
      const v = row[key] ?? (key === 'skill_level' ? row.mainSkillLevel : null);
      if (v == null) continue;
      if (!bounded(v,min,max)) throw new Error(c.name + ' 的 ' + key + ' 超出范围。');
      op[key] = v;
    }
    const skillLevels = row.skill_levels ?? (Array.isArray(row.skills) && op.skill_level ? row.skills.map(s =>
      bounded(s?.level,0,3) ? (s.level ? 7+s.level : op.skill_level) : null) : null);
    if (skillLevels != null) {
      if (!Array.isArray(skillLevels) || skillLevels.length > 3 ||
          !skillLevels.every(n => n === null || bounded(n,1,10))) throw new Error('skill_levels 请按技能顺序填 1–10 或 null。');
      op.skill_levels = skillLevels;
    }
    return op;
  });
  return {complete:raw.complete === true,operators};
}
function problems(choice, op) {
  const r = choice.requirements || {}, skill = choice.skill || 0, issues = [];
  const maxSkill = op.rarity < 3 ? 0 : op.rarity < 4 ? 1 : op.rarity === 6 || op.id === 'char_002_amiya' ? 3 : 2;
  if (!bounded(skill,0,maxSkill)) issues.push('不足');
  const elite = Math.max(0,skill-1,r.elite || 0,r.module > 0 || r.skill_level > 7 ? 2 : r.skill_level > 4 ? 1 : 0);
  const need = (have,min) => { if (min > 0 && !(have >= min)) issues.push(have == null ? '待补充' : '不足'); };
  need(op.elite,elite);
  if (!(r.elite >= 0 && op.elite > r.elite)) need(op.level,r.level);
  const level = op.skill_levels?.[skill-1] ?? op.skill_level;
  // A known common level of seven alone does not establish or rule out mastery.
  need(r.skill_level > 7 && !op.skill_levels?.[skill-1] && level === 7 ? null : level,r.skill_level);
  if (r.module > 0 && op.module !== r.module) issues.push(op.module == null ? '待补充' : '不足');
  need(op.module_level,r.module_level); need(op.potential,r.potential);
  return issues;
}
const deploy = a => ['Deploy','部署'].includes(a.type || 'Deploy');
const sameCell = (a,b) => a && b && a[0] === b[0] && a[1] === b[1];
function slots(plan) {
  return [...(plan.opers || []).map(o=>({name:o.name,choices:[o]})),...(plan.groups || []).map(g=>({name:g.name,choices:g.opers}))];
}
function matches(o,c) {
  const role = c.role?.toLowerCase();
  return o.name === c.name && (!role || o.role === (roleAliases[role] || role));
}
export function assess(plan,roster) {
  return slots(plan).map(s => ({slot:s.name,choices:s.choices.map(c => {
    const found = roster.operators.filter(o => matches(o,c));
    const op = found.find(o=>o.owned);
    const issues = op ? problems(c,op) : [];
    const status = !op ? (found.length || roster.complete ? '未持有' : '尚未识别') :
      issues.includes('不足') ? '练度或技能不足' : issues.length ? '练度资料待补充' : '持有且满足已知要求';
    const training = Number.isInteger(op?.elite) && Number.isInteger(op.level) ? {name:op.name,elite:op.elite,level:op.level} : undefined;
    return {...c,status,training};
  })}));
}

export function rosterFit(plan,roster) {
  const slots=assess(plan,roster), unconfirmedSlots=[], matched=[];
  const byTraining=(a,b)=>a.elite-b.elite || a.level-b.level;
  for (const slot of slots) {
    const known=slot.choices.filter(choice=>choice.status === '持有且满足已知要求');
    if (!known.length) unconfirmedSlots.push(slot.slot);
    const strongest=known.map(choice=>choice.training).filter(Boolean).sort(byTraining).at(-1);
    if (strongest) matched.push(strongest);
  }
  const leastTrained=matched.length === slots.length ? matched.sort(byTraining)[0] : undefined;
  return {unconfirmedSlots,leastTrained};
}

export async function adaptGuide(plan,roster,notes,propose) {
  checkPlan(plan);
  const board = await stageBoard(plan.stage_name), layout = board?.tiles;
  const candidates = roster.operators.filter(o=>o.owned);
  const assessment = assess(plan,roster);
  if (!assessment.length || plan.actions.length > 250) throw new Error('此作业缺少可适配编队或动作超过 250 步，请选择其他作业。');
  const {ranges,characters:chars} = await characters(), usedRanges = {};
  const operators = candidates.map(({rangeIds,tokens,owned,...op})=>{
    const range = rangeIds?.[op.elite];
    if (range && ranges[range]) usedRanges[range] = ranges[range];
    return {...op,range,...(tokens.length ? {tokens} : {})};
  });
  const result = await propose({plan,assessment,operators,...board,attackRanges:usedRanges,notes});
  if (typeof result?.reason !== 'string' || !result.reason.trim()) throw new Error('模型没有解释替补方案。');
  const reason = result.reason.slice(0,4000);
  if (result.status === 'blocked') return {ready:false,reason,assessment};
  const slotsInPlan = slots(plan);
  if (result.status !== 'ready' || !Array.isArray(result.picks) || result.picks.length !== slotsInPlan.length ||
      !Array.isArray(result.edits) || result.edits.length > plan.actions.length) throw new Error('模型没有为每个编队位给出唯一人选。');
  const selected = new Map(), used = new Set(), changes = [];
  const output = structuredClone(plan);
  for (const slot of slotsInPlan) {
    const pick = result.picks.find(p => p?.slot === slot.name);
    const op = candidates.find(o => o.id === pick?.id);
    if (!op || selected.has(slot.name) || used.has(op.name)) throw new Error('编队位置重复或人选未确认持有：' + slot.name);
    const authored = slot.choices.find(c => matches(op,c) && c.skill === pick.skill) || slot.choices.find(c => matches(op,c));
    const base = authored || slot.choices.find(c=>c.name === pick.basedOn);
    if (!base || !bounded(pick.skill,0,3)) throw new Error('缺少有效的原作业参照或技能序号：' + slot.name);
    const choice = {...base,name:op.name,role:op.role,skill:pick.skill};
    if (pick.skill_usage != null) {
      if (!bounded(pick.skill_usage,0,2)) throw new Error('技能用法无效。');
      choice.skill_usage = pick.skill_usage;
    }
    if (problems(choice,op).length) throw new Error(op.name + ' 的技能或练度无法满足要求，请补全名册或换人。');
    if (!authored && (op.elite == null || op.level == null)) throw new Error('缺少替补干员的精英阶段或等级：' + op.name);
    if (!authored && (base.requirements?.module > 0 || !layout)) throw new Error('缺少地图或原作业依赖专属模组，请选择其他作业。');
    const originalTokens = chars.filter(c=>slot.choices.some(o=>matches(c,o))).flatMap(c=>c.tokens);
    const tokenActions = plan.actions.filter(a=>originalTokens.includes(a.name));
    if (tokenActions.length && (!authored || pick.skill !== (authored.skill || 0) ||
        tokenActions.some(a=>!op.tokens.includes(a.name)))) throw new Error('作业依赖原干员及其技能提供的召唤物，请选择其他作业。');
    selected.set(slot.name,{op,choice}); used.add(op.name);
    changes.push(slot.name + ' → ' + op.name + '（技能 ' + pick.skill + '）');
  }
  for (const g of output.groups || []) g.opers = [selected.get(g.name).choice];
  const direct = new Map((output.opers || []).map(o=>[o.name,selected.get(o.name)]));
  if (output.opers) output.opers = [...direct.values()].map(s=>s.choice);
  const aliases = new Set((output.groups || []).map(g=>g.name));
  if ([...direct.values()].some(s=>aliases.has(s.op.name))) throw new Error('替补名与作业分组重名。');
  const tokens = new Set([...selected.values()].flatMap(s=>s.op.tokens));
  const edited = new Set(), occupied = new Map();
  const firstDeploy = plan.actions.findIndex(deploy);
  for (const edit of result.edits) {
    if (!bounded(edit?.step,1,output.actions.length) || edited.has(edit.step)) throw new Error('修改的作业步骤无效。');
    edited.add(edit.step);
    const a = output.actions[edit.step-1];
    for (const [key,value] of Object.entries(edit)) {
      if (key === 'step') continue;
      if (key === 'location' || key === 'direction') {
        if (!deploy(a) || !selected.has(a.name)) throw new Error('只能调整已确认干员的部署格和朝向。');
        if (key === 'location' && (!layout || !Array.isArray(value) || value.length !== 2 || !value.every(Number.isInteger))) throw new Error('无法校验目标格。');
        if (key === 'location' && !sameCell(value,a.location) && output.actions.some(other => other !== a && !deploy(other) &&
            (sameCell(other.location,a.location) || other.rect || other.begin || other.end))) throw new Error('其他动作引用原位置或固定屏幕区域，无法安全搬移。');
      } else if (!['kills','costs','pre_delay','post_delay'].includes(key) || !bounded(value,0,key.endsWith('delay') ? 120000 : key === 'costs' ? 99 : 999)) {
        throw new Error('模型给出的时机或动作字段不受支持。');
      }
      if (key === 'kills' && edit.step <= firstDeploy + 1 && value > (a.kills || 0)) {
        throw new Error('作业尚未部署干员，不能增加开局击杀条件。请沿用原作业的开局时机。');
      }
      a[key] = value;
    }
    changes.push('第 ' + edit.step + ' 步 ' + JSON.stringify(edit));
  }
  for (const [i,a] of output.actions.entries()) {
    const entry = selected.get(a.name);
    if (deploy(a)) {
      if (!entry && !tokens.has(a.name)) throw new Error('未确认部署单位或召唤物来源：' + a.name);
      const [x,y] = a.location;
      if (entry && layout) {
        const tile = layout[y]?.[x], position = {MELEE:1,RANGED:2,ALL:3}[entry.op.position];
        if (!(tile > 0 && (tile === 3 || position === 3 || tile === position))) throw new Error('第 ' + (i+1) + ' 步不符合该干员的部署地形。');
      }
      const cell = a.location.join(',');
      if (occupied.has(cell) && result.edits.some(e=>e.location)) throw new Error('改位后出现未经撤退确认的重叠部署。');
      occupied.set(cell,a.name);
    }
    if (['Retreat','撤退'].includes(a.type)) {
      if (a.location) occupied.delete(a.location.join(','));
      else for (const [cell,name] of occupied) if (name === a.name) occupied.delete(cell);
    }
    if (direct.has(a.name)) { a.name = entry.op.name; if (a.role) a.role = entry.op.role; }
  }
  return {ready:true,reason,assessment,changes,plan:checkPlan(output),source:'按当前名册适配'};
}
