export const defaultCodexModel='gpt-6.2-sol';

// Older releases inferred API mode from a saved URL and could persist that inference.
export function selectedProvider(settings) {
  return settings.provider==='api' && settings.apiOptIn===true ? 'api' : 'codex';
}

export function modelSettings(settings) {
  const {vision,limit}=settings;
  if (selectedProvider(settings)==='api') {
    return {provider:'api',apiOptIn:true,url:settings.url,key:settings.key,model:settings.apiModel,vision,limit};
  }
  return {provider:'codex',model:settings.codexModel,vision,limit};
}
