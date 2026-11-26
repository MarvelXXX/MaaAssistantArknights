import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { codexCompletion } from '../lib/codex-cli.mjs';

test('Codex 订阅模式拒绝使用 API Key 登录的 CLI',async()=>{
  const calls=[];
  await assert.rejects(codexCompletion('gpt-6.2-sol',[],undefined,async args=>{
    calls.push(args);return {stdout:'',stderr:'Logged in using an API key'};
  }),/ChatGPT 登录/);
  assert.deepEqual(calls,[['login','status']]);
});

test('图像按顺序作为 CLI 附件，指令走标准输入，最终回复交还 ArkPilot',async()=>{
  let work;
  const image=text=>({type:'image_url',image_url:{url:'data:image/jpeg;base64,'+Buffer.from(text).toString('base64')}});
  const reply='{"action":{"type":"finish"}}';
  const run=async(args,options)=>{
    if (args[0]==='login') return {stdout:'',stderr:'Logged in using ChatGPT'};
    work=options.cwd;
    assert.ok(args.includes('--ephemeral') && args.includes('read-only') && args.includes('forced_login_method="chatgpt"'));
    assert.equal(args.at(-1),'-');
    assert.ok(!args.includes('这是用户指令'));
    assert.match(options.input,/这是用户指令/);
    const files=args.flatMap((v,i)=>v==='--image' ? [args[i+1]] : []);
    assert.deepEqual(await Promise.all(files.map(f=>readFile(f,'utf8'))),['first','second']);
    return {stdout:[{type:'item.completed',item:{type:'agent_message',text:reply}},{type:'turn.completed'}].map(e=>JSON.stringify(e)).join('\n')};
  };
  const messages=[{role:'user',content:[{type:'text',text:'这是用户指令'},image('first'),image('second')]}];
  assert.equal(await codexCompletion('gpt-6.2-sol',messages,undefined,run),reply);
  await assert.rejects(stat(work),{code:'ENOENT'});
});
