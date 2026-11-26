import cv from '@techstark/opencv-js';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The Emscripten module itself is thenable; resolve without returning it.
const ready = new Promise(resolve => cv.then(() => resolve()));
const resource = process.env.ARK_MAA_RESOURCE || fileURLToPath(new URL('../../../resource/', import.meta.url));
const labels = {
  GameStart: '启动页 START',
  Home: '主界面设置入口', StartToWakeUp: '点击开始', ReceiveAward: '领取任务奖励',
  WeeklyTask: '周常任务标签', ReceiveMail: '领取邮件附件', StartButton2: '编队页开始行动',
  BattleStartExercise: '演习编队页 PLAN 开始行动',
  'StageDrops-Stars-3': '结算三星标志', 'StageDrops-Stars-2': '结算二星标志',
  'StageDrops-Stars-Adverse': '磨难结算标志', UseStone: '源石恢复提示',
  OperOpenInformationMenu: '干员档案入口', OperOpenParadox: '档案中的悖论模拟入口',
  OperOpenParadoxChooseSkill: '悖论模拟开始按钮',
  UseMedicine: '理智药恢复提示',
  BattleCostFlag: '战斗部署费用图标', BattleHpFlag: '战斗防御点图标', BattleHpFlag2: '战斗防御点图标',
};
const languages = {
  'com.YoStarEN.Arknights': 'en-US', 'com.YoStarJP.Arknights': 'ja-JP',
  'com.YoStarKR.Arknights': 'ko-KR', 'tw.txwy.and.arknights': 'zh-TW',
};

function pixels(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width * height > 16000000) throw new Error('截图尺寸超出可处理范围。');
  return PNG.sync.read(png);
}

function grayMat(image) {
  const rgba = cv.matFromImageData(image);
  const gray = new cv.Mat();
  try { cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY); }
  finally { rgba.delete(); }
  return gray;
}

const archiveTemplates = new Map();
export async function archiveCard(frame, stageCode) {
  const prefix=stageCode.split('-')[0];
  if (!['GO','CV'].includes(prefix) || Math.abs(frame.width/frame.height-16/9)>0.04) return null;
  await ready;
  if (!archiveTemplates.has(prefix)) {
    const bytes=await readFile(new URL('./archive-templates/'+prefix+'.png',import.meta.url));
    archiveTemplates.set(prefix,grayMat(pixels(bytes)));
  }
  const template=archiveTemplates.get(prefix),scale=720/frame.width;
  const gray=grayMat(frame.image),reference=new cv.Mat(),result=new cv.Mat();
  try {
    cv.resize(gray,reference,new cv.Size(720,Math.round(frame.height*scale)),0,0,cv.INTER_AREA);
    cv.matchTemplate(reference,template,result,cv.TM_CCOEFF_NORMED);
    const {maxVal,maxLoc}=cv.minMaxLoc(result);
    if (maxVal<0.85 || maxLoc.y<reference.rows*0.1) return null;
    return {x:Math.round((maxLoc.x+template.cols/2)/scale),y:Math.round((maxLoc.y+template.rows/2)/scale)};
  } finally {
    result.delete(); reference.delete(); gray.delete();
  }
}

let templatesPromise;
async function loadTemplates() {
  const tasks = JSON.parse(await readFile(path.join(resource, 'tasks', 'tasks.json'), 'utf8'));
  const dir = path.join(resource, 'template');
  const entries = await readdir(dir, { recursive: true });
  const files = new Map(entries.map(name => [path.basename(name), path.join(dir, name)]));
  const templates = [];
  for (const [task, label] of Object.entries(labels)) {
    const spec = tasks[task];
    const roi = spec?.roi ?? tasks[spec?.baseTask]?.roi;
    // The START icon has a black background in both the template and its on-screen ROI.
    if (!roi || (spec.maskRange && task !== 'GameStart')) continue;
    for (const file of [spec.template || task + '.png'].flat()) {
      if (!files.has(file)) continue;
      const mat = grayMat(pixels(await readFile(files.get(file))));
      templates.push({ task, label, mat, roi, threshold: Math.max(0.84, spec.templThreshold || 0) });
    }
  }
  return templates;
}

async function matchTemplates(image, client) {
  if (languages[client]) return { anchors: [], status: '外服使用 OCR 与视觉识别' };
  if (Math.abs(image.width / image.height - 16 / 9) > 0.04) return { anchors: [], status: '当前比例使用 OCR 与视觉识别' };
  await ready;
  templatesPromise ??= loadTemplates().catch(() => []);
  const templates = await templatesPromise;
  if (!templates.length) return { anchors: [], status: '未加载 Maa 模板' };
  const gray = grayMat(image);
  const reference = new cv.Mat();
  const hits = new Map();
  try {
    cv.resize(gray, reference, new cv.Size(1280, 720), 0, 0, cv.INTER_AREA);
    for (const { task, label, mat, roi, threshold } of templates) {
      const [x, y, w, h] = roi;
      if (x < 0 || y < 0 || w < mat.cols || h < mat.rows || x + w > 1280 || y + h > 720) continue;
      const area = reference.roi(new cv.Rect(x, y, w, h));
      const result = new cv.Mat();
      try {
        cv.matchTemplate(area, mat, result, cv.TM_CCOEFF_NORMED);
        const { maxVal, maxLoc } = cv.minMaxLoc(result);
        if (maxVal < threshold || hits.get(task)?.score >= maxVal) continue;
        const sx = image.width / 1280, sy = image.height / 720;
        hits.set(task, { label, source: 'Maa', score: +maxVal.toFixed(3),
          box: [(x + maxLoc.x) * sx, (y + maxLoc.y) * sy, mat.cols * sx, mat.rows * sy].map(Math.round) });
      } finally { area.delete(); result.delete(); }
    }
  } finally { gray.delete(); reference.delete(); }
  return { anchors: [...hits.values()], status: 'Maa 模板已加载' };
}

export function isPracticeFormation(frame) {
  return frame.anchors.some(a=>a.source==='Maa' && a.label==='演习编队页 PLAN 开始行动') ||
    frame.anchors.some(a=>a.source==='OCR' && /\bPLAN\b/i.test(a.label) && a.box?.[0]>frame.width*0.76 && a.box[1]>frame.height*0.50);
}

function readText(frame, signal) {
  if (process.platform !== 'win32') return Promise.resolve({ lines: [], status: '当前系统无 Windows OCR' });
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL('./ocr.ps1', import.meta.url));
    const child = execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, languages[frame.client] || 'zh-CN'],
      { signal, timeout: 14000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (signal?.aborted) return reject(signal.reason);
        try {
          if (error) throw error;
          const lines = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
          resolve({ status: 'Windows OCR 已启用',
            lines: lines.slice(0, 120).map(line => ({ ...line, source: 'OCR',
              label: line.label.replace(/(?<=[\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '') })) });
        } catch { resolve({ lines: [], status: 'Windows OCR 不可用，请检查系统 OCR 语言包' }); }
      });
    child.stdin.on('error', () => {}); // Process may exit before consuming stdin on cancellation.
    child.stdin.end(frame.png);
  });
}

export async function recognize(frame, signal) {
  const image = pixels(frame.png);
  const [templates, ocr] = await Promise.all([matchTemplates(image, frame.client), readText(frame, signal)]);
  signal?.throwIfAborted();
  if (templates.anchors.some(a => a.label === '悖论模拟开始按钮') &&
      ocr.lines.some(line => line.label === '悖论模拟') &&
      !ocr.lines.some(line => line.label.replace(/[\s\p{P}\p{S}]/gu, '') === '已完成模拟作战')) {
    const badge = await readParadoxCompletion(image, frame.client, signal);
    if (badge) ocr.lines.push(badge);
  }
  const anchors = [...templates.anchors, ...ocr.lines].map((a, i) => ({ ...a, id: i + 1 }));
  await ready;
  const rgba = cv.matFromImageData(image), small = new cv.Mat();
  const scale = Math.min(1, 1440 / Math.max(image.width, image.height));
  try {
    cv.resize(rgba, small, new cv.Size(Math.round(image.width * scale), Math.round(image.height * scale)), 0, 0, cv.INTER_AREA);
    const bytes = jpeg.encode({ data: small.data, width: small.cols, height: small.rows }, 82).data;
    return { ...frame, image, anchors, preview: 'data:image/jpeg;base64,' + bytes.toString('base64'),
      recognition: [templates.status, ocr.status] };
  } finally { rgba.delete(); small.delete(); }
}

export function intelBalanceCrop(frame) {
  const labels=frame.anchors.map(a=>a.label.replace(/\s/g,''));
  if (!frame.image || Math.abs(frame.width/frame.height-16/9)>0.015 || !labels.includes('合成玉') ||
      !(labels.includes('购买物品') || labels.some(s=>s.includes('关于情报凭证区')))) return;
  const box=[1338,26,98,34].map((n,i)=>Math.round(n*(i%2 ? frame.height/810 : frame.width/1440)));
  const [left,top,w,h]=box, scale=4, width=w*scale, height=h*scale;
  const data=Buffer.alloc(width*height*4);
  let first=w, last=-1;
  for (let y=0;y<h;y++) {
    for (let x=0;x<w;x++) {
      const src=4*((top+y)*frame.width+left+x);
      const rgba=frame.image.data.readUInt32LE(src);
      if (Math.min(...frame.image.data.subarray(src,src+3))>160) { first=Math.min(first,x); last=Math.max(last,x); }
      for (let dx=0;dx<scale;dx++) data.writeUInt32LE(rgba,4*(y*scale*width+x*scale+dx));
    }
    const line=4*y*scale*width;
    for (let dy=1;dy<scale;dy++) data.copy(data,line+4*width*dy,line,line+4*width);
  }
  // The shop header uses fixed-width digits. A truncated OCR string must never match a smaller balance.
  const digits=Math.round((last-first+1)/(15.6*frame.width/1440));
  if (digits<1 || digits>6) return;
  return {box,digits,width,height,preview:'data:image/jpeg;base64,'+jpeg.encode({width,height,data},94).data.toString('base64')};
}

export function intelShopStock(frame, tickets, stock) {
  const labels=frame.anchors.map(a=>a.label.replace(/\s/g,''));
  if (!labels.includes('合成玉') || !frame.anchors.some(a=>a.source==='凭证读数' && a.label===String(tickets) && a.box &&
      a.box[0]/frame.width>0.92 && a.box[1]/frame.height<0.085)) return false;
  if (labels.includes('购买物品')) return labels.includes('剩余'+stock) && labels.includes('售价20');
  if (!labels.some(s=>s.includes('关于情报凭证区'))) return false;
  return frame.anchors.some(a=>a.box && a.box[0]/frame.width>0.29 && a.box[0]/frame.width<0.39 &&
    a.box[1]/frame.height>0.245 && a.box[1]/frame.height<0.31 &&
    new RegExp('余'+stock+'(?!\\d)').test(a.label.replace(/\s/g,'')));
}

// The completion text in the lower left is grey on black; exclude the adjoining checkmark.
async function readParadoxCompletion(image, client, signal) {
  const sx = image.width / 1280, sy = image.height / 720;
  const box = [Math.round(48 * sx), Math.round(661 * sy), Math.round(140 * sx), Math.round(27 * sy)];
  const gray = grayMat(image), crop = gray.roi(new cv.Rect(...box));
  const zoom = new cv.Mat(), padded = new cv.Mat(), rgba = new cv.Mat();
  let png;
  try {
    cv.resize(crop, zoom, new cv.Size(280, 54), 0, 0, cv.INTER_CUBIC);
    cv.normalize(zoom, zoom, 0, 255, cv.NORM_MINMAX);
    cv.bitwise_not(zoom, zoom);
    cv.copyMakeBorder(zoom, padded, 10, 10, 12, 12, cv.BORDER_CONSTANT, new cv.Scalar(255));
    cv.cvtColor(padded, rgba, cv.COLOR_GRAY2RGBA);
    png = PNG.sync.write({ width: rgba.cols, height: rgba.rows, data: rgba.data });
  } finally {
    rgba.delete(); padded.delete(); zoom.delete(); crop.delete(); gray.delete();
  }
  const { lines } = await readText({ png, client }, signal);
  signal?.throwIfAborted();
  const label = '已完成模拟作战';
  if (lines.some(line => line.label.replace(/\s/g, '') === label)) return { source: 'OCR', label, box };
}

export function hasFacingPrompt(before, after, target) {
  if (before.width !== after.width || before.height !== after.height || before.client !== after.client) return false;
  const old = before.image || pixels(before.png), latest = pixels(after.png);
  // The red cancel tile appears to the upper left of the deployment diamond.
  const left = Math.max(0,Math.floor(target.x - after.width * 0.20));
  const top = Math.max(0,Math.floor(target.y - after.height * 0.27));
  const right = Math.min(after.width,Math.ceil(target.x - after.width * 0.035));
  const bottom = Math.min(after.height,Math.ceil(target.y - after.height * 0.035));
  let red = 0, white = 0, samples = 0;
  function isRed(data,i) { return data[i] > 95 && data[i] > data[i+1] * 2.5 && data[i] > data[i+2] * 2.5; }
  for (let y = top; y < bottom; y += 3) {
    for (let x = left; x < right; x += 3) {
      const i = (y * after.width + x) * 4;
      samples++;
      if (isRed(latest.data,i) && !isRed(old.data,i)) red++;
      if (latest.data[i] > 218 && latest.data[i+1] > 218 && latest.data[i+2] > 218) white++;
    }
  }
  return samples > 0 && red > samples * 0.025 && white > samples * 0.004;
}

// Recheck both the scene and the target patch after model latency. Small animations
// are tolerated, while a menu transition or a disappearing button triggers a new plan.
export function stillMatches(observed, current, action) {
  if (observed.width !== current.width || observed.height !== current.height) return false;
  if (observed.png.equals(current.png)) return true;
  const before = observed.image, after = pixels(current.png);
  function changedFraction(x, y, width, height, stride) {
    let changed = 0, total = 0;
    for (let row = Math.max(0, y); row < Math.min(before.height, y + height); row += stride) {
      for (let col = Math.max(0, x); col < Math.min(before.width, x + width); col += stride) {
        const i = (row * before.width + col) * 4;
        const diff = Math.abs(before.data[i] - after.data[i]) + Math.abs(before.data[i+1] - after.data[i+1]) + Math.abs(before.data[i+2] - after.data[i+2]);
        if (diff > 114) changed++;
        total++;
      }
    }
    return changed / Math.max(1, total);
  }
  if (changedFraction(0, 0, before.width, before.height, 12) > 0.30) return false;
  return action.type === 'back' || changedFraction(action.x - 22, action.y - 14, 45, 29, 3) < 0.34;
}

let readyMarker;
function yellowMask(image, left=0, top=0, width=image.width, height=image.height, scale=1) {
  const mat=new cv.Mat(height,width,cv.CV_8UC1);
  const data=mat.data;
  for (let y=0;y<height;y++) {
    for (let x=0;x<width;x++) {
      const i=4*(Math.floor((top+y)*scale)*image.width+Math.floor((left+x)*scale));
      const r=image.data[i],g=image.data[i+1],b=image.data[i+2];
      data[y*width+x]=r>180 && g>138 && b<85 && r-g<116 ? 255 : 0;
    }
  }
  return mat;
}

// A melee animation can cover the tapped operator while the ready marker stays over the same tile.
export async function sameReadyOperator(before,after,action) {
  const hud=anchors=>anchors?.some(a=>a.source==='Maa' && a.label==='战斗防御点图标');
  if (action.type!=='tap' || !hud(before.anchors) || before.client!==after.client ||
      before.width!==after.width || before.height!==after.height || Math.abs(before.width/before.height-16/9)>0.01) return false;
  const scale=before.height/720;
  const left=Math.round(action.x/scale)-32,top=Math.round(action.y/scale)-137;
  if (left<0 || top<0 || left+64>before.width/scale || top+115>720) return false;
  await ready;
  readyMarker ??= readFile(path.join(resource,'template','Battle','BattleFlag','BattleSkillReady.png'))
    .then(bytes=>yellowMask(pixels(bytes))).catch(()=>null);
  const marker=await readyMarker;
  if (!marker) return false;
  const position=image=>{
    const area=yellowMask(image,left,top,64,115,scale),result=new cv.Mat();
    try {
      cv.matchTemplate(area,marker,result,cv.TM_CCOEFF_NORMED);
      const {maxVal,maxLoc}=cv.minMaxLoc(result);
      return maxVal>=0.84 ? maxLoc : null;
    } finally { area.delete(); result.delete(); }
  };
  const previous=position(before.image || pixels(before.png));
  if (!previous) return false;
  const image=pixels(after.png),latest=position(image);
  if (!latest || Math.abs(previous.x-latest.x)>3 || Math.abs(previous.y-latest.y)>3) return false;
  return hud((await matchTemplates(image,after.client)).anchors);
}
