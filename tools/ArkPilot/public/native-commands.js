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
  const stage = /^\/定位活动关卡\s+([A-Z]{1,4}-(?:TR-)?[1-9]\d?)$/i.exec(instruction || '')?.[1];
  if (stage) return {task:'ArchiveStage',stage:stage.toUpperCase()};
  return task ? {task} : null;
}
