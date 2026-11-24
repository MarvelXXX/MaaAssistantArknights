import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const clients = new Set([
  'com.hypergryph.arknights', 'com.hypergryph.arknights.bilibili',
  'com.YoStarEN.Arknights', 'com.YoStarJP.Arknights',
  'com.YoStarKR.Arknights', 'tw.txwy.and.arknights',
]);

function adbPath() {
  if (process.env.ARK_ADB) return process.env.ARK_ADB;
  const roots = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  const candidates = roots.filter(Boolean).map(root =>
    path.join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Netease', 'MuMu', 'nx_main', 'adb.exe'));
  return candidates.find(p => existsSync(p)) || 'adb';
}

async function adb(args, signal) {
  try {
    const { stdout } = await execute(adbPath(), args, {
      windowsHide: true, encoding: 'buffer', maxBuffer: 24 * 1024 * 1024, timeout: 18000, signal,
    });
    return stdout;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new Error('找不到 ADB。请安装 Android Platform Tools，或用 ARK_ADB 指定 adb 可执行文件。');
    throw new Error('ADB 命令失败。' + (error.stderr?.toString().trim().slice(0, 300) || '请检查设备连接。'));
  }
}

export async function listDevices(signal) {
  const output = (await adb(['devices', '-l'], signal)).toString();
  return output.split(/\r?\n/).flatMap(line => {
    const m = line.match(/^([^\s]+)\s+(device|offline|unauthorized)\b(.*)/);
    if (!m) return [];
    return [{ serial: m[1], state: m[2], model: m[3].match(/\bmodel:(\S+)/)?.[1] || '' }];
  });
}

export async function connectDevice(address, signal) {
  if (typeof address !== 'string' || !/^(?:[a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\]):[1-9]\d{0,4}$/i.test(address) ||
      Number(address.split(':').pop()) > 65535) throw new Error('请输入 ADB 地址和端口，例如 127.0.0.1:16384。');
  const reply = (await adb(['connect', address], signal)).toString().trim();
  if (!/^(already )?connected to /i.test(reply)) throw new Error('连接失败。' + reply.slice(0, 200));
  return listDevices(signal);
}

export async function selectDevice(serial, signal) {
  const devices = await listDevices(signal);
  if (!devices.some(d => d.serial === serial && d.state === 'device')) throw new Error('请选择在线且已授权的 ADB 设备。');
  const run = (args, s) => adb(['-s', serial, ...args], s);
  let client;
  async function checkGame(s) {
    const output = (await run(['shell', 'dumpsys', 'window', 'displays'], s)).toString();
    const focus = output.split(/\r?\n/).find(line => line.includes('mCurrentFocus='));
    let pkg = focus?.match(/\bu\d+\s+([\w.]+)\//)?.[1];
    if (!focus) {
      const activities = (await run(['shell', 'dumpsys', 'activity', 'activities'], s)).toString();
      pkg = activities.match(/(?:topResumedActivity|mResumedActivity|ResumedActivity)[:=][^\n]*?\bu\d+ ([\w.]+)\//)?.[1];
    }
    if (!clients.has(pkg) || (client && pkg !== client)) {
      throw new Error('请将选中设备上的明日方舟切到前台，再继续。');
    }
    client = pkg;
    return pkg;
  }
  return {
    async capture(s) {
      await checkGame(s);
      const png = await run(['exec-out', 'screencap', '-p'], s);
      await checkGame(s);
      if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('设备没有返回有效 PNG 截图。');
      return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20), client };
    },
    async input(action, s) {
      await checkGame(s);
      const args = action.type === 'back' ? ['keyevent', '4']
        : action.type === 'tap' ? ['tap', action.x, action.y]
        : action.type === 'swipe' ? ['swipe', action.x, action.y, action.x2, action.y2, action.ms] : null;
      if (!args || args.slice(1).some(n => !/^\d+$/.test(String(n)))) throw new Error('不支持的设备动作。');
      await run(['shell', 'input', ...args.map(String)], s);
    },
  };
}
