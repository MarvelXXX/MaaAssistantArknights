import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import { selectDevice } from '../lib/device.mjs';

const game = 'com.hypergryph.arknights';
const png = PNG.sync.write(new PNG({ width: 16, height: 9 }));
const disconnected = () => Object.assign(new Error('offline'), { code: 'ADB_TRANSPORT' });

function simulator(handler) {
  return selectDevice('emulator-5554', undefined, async args => {
    if (args[0] === 'devices') return Buffer.from('emulator-5554 device model:test');
    assert.deepEqual(args.slice(0, 2), ['-s', 'emulator-5554']);
    return handler(args.slice(2).join(' '));
  });
}

const focus = pkg => Buffer.from('mCurrentFocus=Window{123 u0 ' + pkg + '/Main}');

test('ADB 重连或截图截断后重新核查前台并获取新图', async () => {
  let checks = 0, captures = 0;
  const device = await simulator(command => {
    if (command.startsWith('shell dumpsys')) {
      if (++checks === 2) throw disconnected();
      return focus(game);
    }
    assert.equal(command, 'exec-out screencap -p');
    return ++captures === 2 ? png.subarray(0, -12) : png;
  });
  assert.deepEqual(await device.capture(), { png, width: 16, height: 9, client: game });
  assert.equal(captures, 3);
  assert.equal(checks, 6);
});

test('截图失败最多重试两次，取消立即生效', async () => {
  let reads = 0;
  const device = await simulator(() => { reads++; throw disconnected(); });
  await assert.rejects(device.capture(), { code: 'ADB_TRANSPORT' });
  assert.equal(reads, 3);
  const controller = new AbortController();
  const pending = device.capture(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(reads, 4);
});

test('前台变化停止截图，传输异常不会重发设备输入', async () => {
  let foreground = game, captures = 0, inputs = 0;
  const device = await simulator(command => {
    if (command.startsWith('shell dumpsys')) return focus(foreground);
    if (command === 'shell input tap 1 2') { inputs++; throw disconnected(); }
    assert.equal(command, 'exec-out screencap -p');
    captures++;
    foreground = 'com.hypergryph.arknights.bilibili';
    return png;
  });
  await assert.rejects(device.capture(), /前台/);
  assert.equal(captures, 1);
  foreground = game;
  await assert.rejects(device.input({ type: 'tap', x: 1, y: 2 }), { code: 'ADB_TRANSPORT' });
  assert.equal(inputs, 1);
});
