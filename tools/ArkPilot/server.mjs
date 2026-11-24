import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { listDevices, connectDevice, selectDevice } from './lib/device.mjs';
import { recognize } from './lib/vision.mjs';
import { chooseModel, listModels } from './lib/model.mjs';
import { runAgent } from './lib/agent.mjs';

const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 262144) throw new Error('请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new Error('请求需要 JSON 对象。');
}
function modelConfig(data) {
  for (const [key, max] of [['url', 2000], ['key', 4000], ['model', 250]]) {
    if (data[key] != null && (typeof data[key] !== 'string' || data[key].length > max)) throw new Error('模型配置格式有误。');
  }
  if (!data.url?.trim()) throw new Error('请先在连接设置中填写模型服务 URL。');
  return { url: data.url.trim(), key: data.key?.trim(), model: data.model?.trim(), vision: data.vision !== false };
}
function historyFrom(data) {
  if (!Array.isArray(data)) return [];
  return data.slice(-12).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')
    .map(m => ({ role: m.role, text: m.text.slice(0, 4000) }));
}

export function createServer({ getDevice = selectDevice } = {}) {
  let active = false;
  return http.createServer(async (req, res) => {
    // Browser requests must originate in this local UI, including after DNS rebinding.
    const port = req.socket.localPort;
    const host = req.headers.host;
    if (![ '127.0.0.1:' + port, 'localhost:' + port ].includes(host) ||
        (req.headers.origin && req.headers.origin !== 'http://' + host) ||
        req.headers['sec-fetch-site'] === 'cross-site' && req.method !== 'GET') return json(res, 403, { error: '仅接受本机界面请求。' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    try {
      if (req.method === 'GET' && staticFiles.has(req.url)) {
        const [name, type] = staticFiles.get(req.url);
        const file = await readFile(new URL('./public/' + name, import.meta.url));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return res.end(file);
      }
      if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { app: 'ArkPilot', active });
      if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
        return json(res, 404, { error: '未知请求。' });
      }
      const data = await body(req);
      switch (req.url) {
        case '/api/devices': return json(res, 200, { devices: await listDevices(signal) });
        case '/api/connect': return json(res, 200, { devices: await connectDevice(data.address, signal) });
        case '/api/models': return json(res, 200, { models: await listModels(modelConfig(data), signal) });
        case '/api/preview': {
          const device = await getDevice(data.serial, signal);
          const frame = await recognize(await device.capture(signal), signal);
          return json(res, 200, { preview: frame.preview, width: frame.width, height: frame.height,
            client: frame.client, anchors: frame.anchors, recognition: frame.recognition });
        }
        case '/api/run': break;
        default: return json(res, 404, { error: '未知接口。' });
      }
      if (active) return json(res, 409, { error: '已有指令在执行，请在原对话中停止或等待结束。' });
      const config = modelConfig(data);
      const instruction = data.instruction?.trim();
      if (!instruction || instruction.length > 4000) throw new Error('指令长度应在 1 至 4000 字之间。');
      const limit = data.limit ?? 24;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('步数上限应为 1 至 100。');
      active = true;
      try {
        const device = await getDevice(data.serial, signal);
        config.model = await chooseModel(config, signal);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        res.flushHeaders();
        const emit = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
        emit({ type: 'model', model: config.model });
        await runAgent({ config, device, instruction, history: historyFrom(data.history),
          readOnly: data.readOnly === true, limit, signal, emit });
        res.end();
      } finally { active = false; }
    } catch (error) {
      if (res.destroyed) return;
      const message = signal.aborted ? '任务已停止或超时。' : error.message;
      if (!res.headersSent) return json(res, 400, { error: message });
      res.end(JSON.stringify({ type: 'error', text: message }) + '\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ARK_PORT || 17321);
  const url = 'http://127.0.0.1:' + port;
  const open = process.argv.includes('--open') && process.platform === 'win32';
  const browser = () => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log('请在浏览器中打开 ' + url));
    child.unref();
  };
  const server = createServer();
  server.on('error', async error => {
    if (open && error.code === 'EADDRINUSE') {
      try {
        const res = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if ((await res.json()).app === 'ArkPilot') { browser(); return; }
      } catch {}
    }
    console.error('服务启动失败。' + error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('ArkPilot · ' + url);
    if (open) browser();
  });
}
