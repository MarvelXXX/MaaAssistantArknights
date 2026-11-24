import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { importGuide, openBiliMedia, publicJson, searchGuides } from './guides.mjs';
import { ffmpegPath } from './maa.mjs';
import { explainFrames } from './model.mjs';

const execute = promisify(execFile);
const wikiApi = 'https://prts.wiki/api.php?';
const wikiLink = title => 'https://prts.wiki/w/' + encodeURIComponent(title);
const wiki = (params,signal) => publicJson(wikiApi + new URLSearchParams({action:'query',format:'json',...params}),signal);
function plain(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'')
    .replace(/&(?:amp|lt|gt|quot|apos);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[x])).trim();
}
async function wikiSearch(query,signal) {
  const reply = await wiki({list:'search',srsearch:query,srlimit:'6',titles:query,redirects:'1'},signal);
  const pages = Object.values(reply.query?.pages || {}).filter(p=>p.pageid > 0);
  return [...pages,...(reply.query?.search || [])].map(p=>({title:p.title,url:wikiLink(p.title),snippet:plain(p.snippet).slice(0,350),source:'PRTS Wiki'}));
}
export async function readWiki(title,section,signal) {
  const reply = await wiki({titles:title,redirects:'1',prop:'revisions',rvprop:'content',rvslots:'main'},signal);
  const page = Object.values(reply.query?.pages || {})[0];
  const raw = page?.revisions?.[0]?.slots?.main?.['*'];
  if (!raw) throw new Error('未找到这个 PRTS Wiki 页面。');
  const body = raw.replace(/<!--[\s\S]*?-->/g,'').replace(/\n{3,}/g,'\n\n');
  const index = section ? body.indexOf(section) : 0;
  if (index < 0) throw new Error('页面未找到关键词，可更换关键词或不指定章节。');
  return {title:page.title,url:wikiLink(page.title),excerpt:body.slice(Math.max(0,index-80),index+4200)};
}
async function bing(query,signal) {
  const url = new URL('https://cn.bing.com/search');
  url.search = new URLSearchParams({format:'rss',q:'"明日方舟" ' + query});
  const response = await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(9000)]),redirect:'error'});
  if (!response.ok) { await response.body?.cancel(); throw new Error('网页搜索暂不可用'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    if ((size += chunk.length) > 400000) throw new Error('搜索响应过大');
    chunks.push(chunk);
  }
  const xml = Buffer.concat(chunks).toString();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([,item]) => {
    const field = name => plain(item.match(new RegExp('<'+name+'>([\\s\\S]*?)</'+name+'>'))?.[1]);
    const title = field('title'), url = field('link'), snippet = field('description').slice(0,350);
    if (!/^https?:\/\/[^\s]+$/.test(url) || !/明日方舟|arknights|prts\.|罗德岛/i.test(title+' '+snippet+' '+url)) return [];
    return [{title:title.slice(0,200),url,snippet,source:'必应网页摘要'}];
  });
}
async function stationSources(stage,signal) {
  const plans = await searchGuides(stage,signal,'',true);
  return plans.slice(0,15).flatMap(r=>[
    ...r.videos.map(bv=>({title:r.title,url:'https://www.bilibili.com/video/'+bv,bv,snippet:'作业 #'+r.id+' 的作者引用了此视频',source:'作业关联视频'})),
    {title:r.title,url:'https://prts.plus/copilot/'+r.id,id:r.id,source:'PRTS 作业站'},
  ]);
}
export async function searchWeb(query,stage,signal) {
  const providers = [['PRTS Wiki',wikiSearch(query,signal)],['必应',bing(query,signal)]];
  const code = stage || query.match(/\b(?:[A-Z]{1,6}(?:-[A-Z]+)?|\d{1,2})-\d{1,2}\b/i)?.[0];
  if (code) providers.push(['作业站',stationSources(code,signal)]);
  if (/视频|录像|B站|哔哩|bilibili/i.test(query)) {
    const params = new URLSearchParams({search_type:'video',keyword:'明日方舟 '+query});
    const videos = publicJson('https://api.bilibili.com/x/web-interface/search/type?'+params,signal,{Referer:'https://www.bilibili.com/'})
      .then(reply=>{
        if (reply.code !== 0 || !Array.isArray(reply.data?.result)) throw new Error('B 站搜索暂不可用。');
        return reply.data.result.filter(v=>/^BV[a-zA-Z0-9]{10}$/.test(v.bvid)).slice(0,6).map(v=>({
          title:plain(v.title).slice(0,200),snippet:plain(v.description).slice(0,350),bv:v.bvid,url:'https://www.bilibili.com/video/'+v.bvid,source:'B 站视频搜索',
        }));
      });
    providers.push(['B 站视频搜索',videos]);
  }
  const replies = await Promise.allSettled(providers.map(([,p])=>p));
  signal.throwIfAborted();
  const unique = new Map(), unavailable = [];
  replies.forEach((r,i)=>{
    if (r.status !== 'fulfilled') { unavailable.push(providers[i][0]); return; }
    for (const hit of r.value.slice(0,14)) if (!unique.has(hit.url)) unique.set(hit.url,hit);
  });
  return {results:[...unique.values()],unavailable};
}

export async function analyzeVideo(config,{bv,part,start,end},signal) {
  if (!config.vision) throw new Error('解读视频画面需要在连接设置里启用视觉模型。');
  const url = 'https://www.bilibili.com/video/'+bv+'?p='+part;
  const info = await importGuide(url,signal);
  const duration = info.video.duration;
  start ??= 0;
  end = Math.min(end ?? duration,duration);
  if (!Number.isFinite(end) || end-start < 1 || start < 0) throw new Error('片段范围超出视频时长。');
  const seconds = Array.from({length:8},(_,i)=>Number((start+(i+0.5)*(end-start)/8).toFixed(3)));
  const work = await mkdtemp(path.join(tmpdir(),'arkpilot-frames-'));
  try {
    const response = await openBiliMedia(bv,part,signal);
    const cap = 180 * 1024**2;
    if (Number(response.headers.get('content-length')) > cap) { await response.body.cancel(); throw new Error('在线分析支持 180 MiB 以内的视频，可在面板中播放并选择片段。'); }
    const file = path.join(work,'source.mp4'); let total = 0;
    await pipeline(response.body,new Transform({transform(chunk,enc,done) {
      total += chunk.length; done(total > cap ? new Error('公开视频超过 180 MiB。') : null,chunk);
    }}),createWriteStream(file,{flags:'wx'}),{signal});
    const ffmpeg = await ffmpegPath(), frames = [];
    for (const time of seconds) {
      const {stdout} = await execute(ffmpeg,['-nostdin','-v','error','-ss',String(time),'-protocol_whitelist','file,pipe',
        '-f','mov','-i',file,'-map','0:v:0','-an','-sn','-frames:v','1','-vf','scale=min(960\\,iw):-2',
        '-threads','2','-q:v','5','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{windowsHide:true,encoding:'buffer',signal,timeout:18000,maxBuffer:350000});
      if (stdout.length) frames.push({seconds:time,image:'data:image/jpeg;base64,'+stdout.toString('base64')});
    }
    const {notes} = await explainFrames(config,frames,signal);
    return {url,bv,part,start,end,duration,timestamps:frames.map(f=>f.seconds),notes};
  } catch (err) {
    signal.throwIfAborted();
    if (err.code === 'ENOENT') throw new Error('未找到 FFmpeg，请设置 ARK_FFMPEG 或在攻略面板解读所选片段。');
    if (err.cmd) throw new Error('抽取视频帧失败，请尝试其他片段或本地录像。');
    throw err;
  } finally { await rm(work,{recursive:true,force:true,maxRetries:3}); }
}
