import { setTimeout as delay } from 'node:timers/promises';
import { archiveCard, recognize } from './vision.mjs';

const compact = value => value.replace(/\s/g,'');
export function matchesArchiveTitle(label,target) {
  if (compact(label).includes(target.chapter)) return true;
  const suffix = (target.englishTitle || '').toUpperCase().trim().split(/\s+/).slice(-2).join('').replace(/[^A-Z]/g,'');
  return suffix.length>=8 && label.toUpperCase().replace(/[^A-Z]/g,'').includes(suffix);
}

function catalogPosition({image:{width,height,data}}) {
  const samples=[];
  for (let row=1;row<=6;row++) for (let col=1;col<=9;col++) {
    const offset=4*(Math.floor(height*(0.12+row*0.11))*width+Math.floor(width*col/10));
    samples.push((data[offset]+data[offset+1]+data[offset+2])/3);
  }
  return samples;
}

export async function navigateArchive(target,device,signal,native,progress) {
  const capture = async () => recognize(await device.capture(signal),signal);
  let frame = await capture();
  const waitForFrame = async matches => {
    for (let retry=0;retry<4;retry++) {
      if (matches()) return true;
      await delay(450,undefined,{signal});
      frame=await capture();
    }
    return matches();
  };
  const chapterDetail = () => frame.anchors.some(a=>a.box && a.box[0]>frame.width*0.52 &&
    a.box[1]<frame.height*0.4 && matchesArchiveTitle(a.label,target)) &&
    frame.anchors.some(a=>a.box && a.box[1]>frame.height*0.73 && /进入活动|解锁/.test(compact(a.label)));
  const tap = async point => {
    await device.input({type:'tap',...point},signal);
    await delay(900,undefined,{signal});
    frame=await capture();
  };
  const tapText = async (text,area) => {
    const matches = frame.anchors.filter(anchor=>anchor.source==='OCR' && anchor.box &&
      (typeof text==='string' ? compact(anchor.label)===text : text.test(compact(anchor.label))))
      .map(({box:[x,y,w,h]})=>({x:Math.round(x+w/2),y:Math.round(y+h/2)}))
      .filter(p=>!area || area(p.x/frame.width,p.y/frame.height));
    if (matches.length!==1) return false;
    await tap(matches[0]);
    return true;
  };
  if (frame.anchors.some(anchor=>anchor.source==='Maa' && anchor.label==='主界面设置入口')) {
    await native('Terminal-Entry');
    frame = await capture();
  }
  if (frame.anchors.some(anchor=>/前往.*作战|前往.*乍战/.test(compact(anchor.label))) ||
      frame.anchors.some(anchor=>compact(anchor.label)==='乐章') && frame.anchors.some(anchor=>/数据增补|增补仪/.test(compact(anchor.label)))) {
    progress?.('从作战终端打开曲谱');
    await native('Stop@StageTheme');
    await delay(500,undefined,{signal});
    frame = await capture();
  }
  await tapText('乐章收录',(x,y)=>x>0.75 && y<0.18);
  if (frame.anchors.some(anchor=>/默认进度|奖励进度|完成进度/.test(compact(anchor.label)))) {
    await tapText('乐章',(x,y)=>x>0.9 && y<0.12);
  }
  const timeline = () => frame.anchors.some(a=>a.box && a.box[1]<frame.height*0.15 &&
    /开启时间/.test(compact(a.label)));
  let direction=1;
  let onTimeline=timeline(),selectionAttempts=0;
  for (let page=0;page<48;page++) {
    if (onTimeline && !timeline()) {
      await delay(700,undefined,{signal});
      frame=await capture();
    }
    if (!timeline()) break;
    onTimeline=true;
    const title = frame.anchors.find(anchor=>anchor.box && anchor.box[1]>frame.height*0.13 && matchesArchiveTitle(anchor.label,target));
    const card = await archiveCard(frame,target.code);
    if (card) await tap(card);
    if (card || title && await tapText(compact(title.label),(x,y)=>y>0.13)) {
      if (await waitForFrame(chapterDetail) || !timeline()) break;
      if (++selectionAttempts>=2) throw new Error('已识别活动标题，点击后仍停在目录。');
      continue;
    }
    progress?.('在开启时间列表查找'+target.chapter+'（第'+(page+1)+'屏）');
    const {width,height}=frame, previous=catalogPosition(frame);
    await device.input({type:'swipe',x:Math.round(width*0.56),y:Math.round(height*(0.55+direction*0.16)),
      x2:Math.round(width*0.56),y2:Math.round(height*(0.55-direction*0.16)),ms:700},signal);
    await delay(900,undefined,{signal});
    frame = await capture();
    const delta=catalogPosition(frame).reduce((sum,n,i)=>sum+Math.abs(n-previous[i]),0)/previous.length;
    if (delta<3) {
      if (direction===-1) break;
      direction=-1;
    }
  }
  const entered = chapterDetail() && await tapText(/^[^\p{Script=Han}]*进入活动$/u,(x,y)=>x>0.72 && y>0.73);
  const ready = () => {
    const right = frame.anchors.filter(a=>a.box && a.box[0]>0.55*frame.width).map(a=>compact(a.label));
    return right.includes('敌方情报') && (right.includes(compact(target.name)) ||
      right.some(label=>/代理指挥|开始行动|开始作战/.test(label)));
  };
  if (!ready() && (entered || frame.anchors.some(a=>/OP[EF]R[AR]TION/i.test(compact(a.label))))) {
    progress?.('用 Maa 在活动地图上定位 '+target.code);
    await native('ArkPilotArchiveMapNode');
    await delay(750,undefined,{signal});
    frame = await capture();
    await waitForFrame(ready);
  }
  if (ready()) {
    await native('ArkPilotArchiveStageCode');
    return;
  }
  throw new Error('尚未定位到'+target.chapter+' '+target.code+'。已停在当前页面。');
}
