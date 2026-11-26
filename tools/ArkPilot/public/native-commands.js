const commands = new Map([
  ['/活动合成玉', 'ActivityOrundum'],
  ['/跳过剧情', 'SkipStory'],
  ['/退出结算', 'DismissResult'],
  ['/悖论作业', 'ParadoxCopilot'],
  ['/返回首页', 'ReturnHome'],
  ['/作战终端', 'OpenTerminal'],
]);

export function nativeCommand(instruction) {
  const task = commands.get(instruction);
  return task ? {task} : null;
}
