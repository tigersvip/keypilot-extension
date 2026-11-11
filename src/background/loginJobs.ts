import { LOGIN_JOBS_KEY, LOGIN_WAIT_MS, isCertificateError, loginJobActive, sameLoginTarget, type LoginJob } from '../shared/loginJob';
import { isVaultSessionActive } from '../shared/storage';
import { restoreCachedVaultSession } from '../shared/vault';
import type { Credential, FillCredentialPayload, FillCredentialResult, UnlockedVaultSession } from '../shared/types';

const ALARM = 'keypilot-login-jobs';
let writes: Promise<unknown> = Promise.resolve();
const running = new Set<string>();
export interface ManagedLoginGuard {
  documentId: string;
  url: string;
  sessionId: string;
  authorize: () => Promise<boolean>;
}
type Jobs = Record<string, LoginJob>;
async function readJobs(): Promise<Jobs> {
  await writes;
  return (await chrome.storage.session.get(LOGIN_JOBS_KEY))[LOGIN_JOBS_KEY] ?? {};
}
function changeJobs<T>(change: (jobs: Jobs) => T): Promise<T> {
  const operation = writes.then(async () => {
    const jobs: Jobs = (await chrome.storage.session.get(LOGIN_JOBS_KEY))[LOGIN_JOBS_KEY] ?? {};
    const before = JSON.stringify(jobs);
    const result = change(jobs);
    if (JSON.stringify(jobs) !== before) await chrome.storage.session.set({ [LOGIN_JOBS_KEY]: jobs });
    return result;
  });
  writes = operation.catch(() => undefined);
  return operation;
}
async function update(id: string, patch: Partial<LoginJob>): Promise<void> {
  await changeJobs(jobs => {
    if (jobs[id] && loginJobActive(jobs[id])) jobs[id] = { ...jobs[id], ...patch, updatedAt: Date.now() };
  });
}
async function notify(id: string): Promise<void> {
  const shouldOpen = await changeJobs(jobs => {
    if (!jobs[id] || jobs[id].notified) return false;
    jobs[id].notified = true;
    return true;
  });
  if (!shouldOpen) return;
  const url = chrome.runtime.getURL(`login-status.html?job=${encodeURIComponent(id)}`);
  try { await chrome.windows.create({ url, type: 'popup', width: 540, height: 560, focused: true }); }
  catch { await chrome.tabs.create({ url }); }
}
async function stop(id: string, message: string): Promise<void> {
  await update(id, { phase: 'failed', message });
  await notify(id);
}
async function expireJobs() {
  const expired = await changeJobs(jobs => {
    const now = Date.now();
    const ids: string[] = [];
    for (const job of Object.values(jobs)) {
      if (loginJobActive(job) && job.expiresAt <= now) {
        job.phase = 'expired'; job.updatedAt = now;
        job.message = '本次操作已过期，请从密码库重新发起登录。';
        ids.push(job.id);
      } else if (!loginJobActive(job) && now - job.updatedAt > LOGIN_WAIT_MS) delete jobs[job.id];
    }
    return ids;
  });
  for (const id of expired) await notify(id);
  if (!Object.keys(await readJobs()).length) await chrome.alarms.clear(ALARM);
}

export function setupLoginJobs(
  payloadFor: (credential: Credential, autoSubmit: boolean, vault: UnlockedVaultSession['vault'], url: string) => FillCredentialPayload,
  fill: (tabId: number, payload: FillCredentialPayload, guard: ManagedLoginGuard) => Promise<FillCredentialResult>
) {
  async function run(id: string) {
    if (running.has(id)) return;
    running.add(id);
    try {
      const job = (await readJobs())[id];
      if (!job || !loginJobActive(job) || job.phase === 'filling') return;
      if (Date.now() >= job.expiresAt) { await expireJobs(); return; }
      const tab = await chrome.tabs.get(job.tabId).catch(() => null);
      if (!tab) { await update(id, {phase:'cancelled',message:'目标标签页已关闭。'}); return; }
      if (tab.status !== 'complete' || tab.url === 'about:blank') return;
      if (!sameLoginTarget(job.origin, tab.url ?? '', !job.certificateError)) {
        await stop(id, '网站地址已变化，为避免填错账号，本次自动登录已停止。请核实地址后重新发起。'); return;
      }
      const frame = await chrome.webNavigation.getFrame({tabId:job.tabId,frameId:0}).catch(() => null);
      if (!frame || !frame.documentId || frame.errorOccurred || !sameLoginTarget(job.origin, frame.url, !job.certificateError)) return;
      const session = await restoreCachedVaultSession();
      if (!session) { await update(id,{phase:'locked',message:'网页已打开。请解锁密码库，本次操作将在核对后继续。'}); await notify(id); return; }
      const credential = session.vault.credentials.find(item => item.id === job.credentialId);
      if (session.encryptedVault.kdf.salt !== job.vaultId || !credential || !sameLoginTarget(new URL(credential.url).origin, frame.url, true)) {
        await stop(id, '密码库或账号信息已变化，请重新选择账号登录。'); return;
      }
      const active = (await readJobs())[id];
      if (!active || !loginJobActive(active) || active.phase === 'filling' || active.expiresAt <= Date.now()) return;
      if (!session.sessionId || !await isVaultSessionActive(session.sessionId)) return;
      // Bind the continuation to this document, not a later navigation in the same tab.
      const current = await chrome.webNavigation.getFrame({tabId:job.tabId,frameId:0}).catch(() => null);
      if (!current || current.errorOccurred || current.documentId !== frame.documentId || current.url !== frame.url) return;
      if ((job.fillAttempts ?? 0) >= 12) { await stop(id,'未找到可填写的登录表单，请在网站打开登录页面后重新选择账号。'); return; }
      const result = await fill(job.tabId, { ...payloadFor(credential,job.autoSubmit,session.vault,frame.url), singleSubmit: true }, {
        documentId: frame.documentId, url: frame.url, sessionId: session.sessionId,
        authorize: () => changeJobs(jobs => {
          const currentJob = jobs[id];
          if (!currentJob || !loginJobActive(currentJob) || currentJob.phase === 'filling' || currentJob.expiresAt <= Date.now()) return false;
          currentJob.phase = 'filling'; currentJob.updatedAt = Date.now();
          currentJob.fillAttempts = (currentJob.fillAttempts ?? 0) + 1;
          return true;
        })
      });
      if (result.ok) {
        await update(id,{phase:'done',message:result.captchaMessage ?? (result.submitted ? '已填写账号并尝试提交登录，请在网站查看登录结果。' : '已完成填写。请在网站核对内容并继续。')});
      } else if (result.error === 'VAULT_LOCKED') {
        await update(id,{phase:'locked',message:'密码库已锁定，请解锁后继续本次登录。'});
        await notify(id);
      } else if (result.error === 'LOGIN_CONTEXT_CHANGED' || result.error === 'LOGIN_CANCELLED') {
        // A later navigation or unlock event will re-evaluate an active job.
        return;
      } else if (['NO_LOGIN_FORM','NO_PASSWORD_FIELD','Receiving end does not exist.'].some(code=>result.error?.includes(code))) {
        const latest = (await readJobs())[id];
        if (latest?.phase === 'filling') {
          await update(id,{phase:'loading'});
          setTimeout(()=>{void run(id).catch(()=>undefined);},700);
        }
      } else await stop(id,'页面暂时无法自动填写，请返回网站后使用插件手动选择账号。');
    } catch {
      await stop(id,'本次自动登录未完成，请重新解锁密码库并发起登录。').catch(()=>undefined);
    } finally { running.delete(id); }
  }
  async function runForTab(tabId: number) {
    for (const job of Object.values(await readJobs())) if (job.tabId === tabId && loginJobActive(job)) await run(job.id);
  }
  chrome.webNavigation.onErrorOccurred.addListener(details => {
    if (details.frameId !== 0) return;
    void (async () => {
      for (const job of Object.values(await readJobs())) {
        if (job.tabId !== details.tabId || !loginJobActive(job) || job.phase === 'filling') continue;
        if (!sameLoginTarget(job.origin,details.url,!job.certificateError)) { await stop(job.id,'网站跳转到了其他地址，本次自动登录已停止。'); continue; }
        if (isCertificateError(details.error)) {
          await update(job.id,{phase:'certificate',origin:new URL(details.url).origin,certificateError:details.error,expiresAt:job.certificateError ? job.expiresAt : Date.now()+LOGIN_WAIT_MS,message:'Chrome 无法确认此网站的身份。请核实并处理证书问题，本次密码尚未填写。'});
          await notify(job.id);
        } else if (details.error !== 'net::ERR_ABORTED') await stop(job.id,'网站未能正常打开，请检查网络或网站状态后重新发起登录。');
      }
    })().catch(()=>undefined);
  });
  chrome.webNavigation.onCompleted.addListener(details=>{if(details.frameId===0)void runForTab(details.tabId).catch(()=>undefined);});
  chrome.tabs.onRemoved.addListener(tabId=>{
    void changeJobs(jobs=>{for(const job of Object.values(jobs))if(job.tabId===tabId&&loginJobActive(job)){job.phase='cancelled';job.message='目标标签页已关闭。';job.updatedAt=Date.now();}}).catch(()=>undefined);
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='session' && changes['keypilot.sessionState']?.newValue) void (async()=>{
      for(const job of Object.values(await readJobs()))if(job.phase==='locked')await run(job.id);
    })().catch(()=>undefined);
  });
  chrome.alarms.onAlarm.addListener(alarm=>{
    if(alarm.name===ALARM)void (async()=>{
      await expireJobs();
      for(const job of Object.values(await readJobs()))if(loginJobActive(job)&&job.phase!=='filling')await run(job.id);
    })().catch(()=>undefined);
  });
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['KEYPILOT_LOGIN_STATUS','KEYPILOT_LOGIN_CANCEL','KEYPILOT_LOGIN_RETURN'].includes(message?.type))return false;
    if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL(''))){respond({ok:false});return false;}
    void (async()=>{
      await expireJobs();
      const job=(await readJobs())[String(message.id)];
      if(!job)return {ok:true,job:null};
      if(message.type==='KEYPILOT_LOGIN_CANCEL')await changeJobs(jobs=>{
        const current=jobs[job.id];
        if(current&&loginJobActive(current)&&current.phase!=='filling'){
          current.phase='cancelled';current.updatedAt=Date.now();current.message='已取消本次登录，不再自动填写。';
        }
      });
      if(message.type==='KEYPILOT_LOGIN_RETURN'){
        const tab=await chrome.tabs.get(job.tabId).catch(()=>null);
        if(tab){await chrome.windows.update(tab.windowId,{focused:true});await chrome.tabs.update(job.tabId,{active:true});}
      }
      const latest=(await readJobs())[job.id];
      const {credentialId:_,vaultId:__,...publicJob}=latest;
      return {ok:true,job:publicJob};
    })().then(respond).catch(()=>respond({ok:false}));
    return true;
  });
  // Recover metadata after a service worker restart; never persist login secrets in the queue.
  void (async()=>{
    await expireJobs();
    for(const job of Object.values(await readJobs())){
      if(job.phase==='filling')await stop(job.id,'后台已重新启动，请重新发起登录以免重复提交。');
      else if(loginJobActive(job))await run(job.id);
    }
  })().catch(()=>undefined);
  return async (credentialId: string, autoSubmit: boolean) => {
    const session=await restoreCachedVaultSession();
    const credential=session?.vault.credentials.find(item=>item.id===credentialId);
    if(!session||!credential)throw new Error('VAULT_LOCKED');
    const target=new URL(credential.url);
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('INVALID_CREDENTIAL_URL');
    const tab=await chrome.tabs.create({url:'about:blank',active:true});
    if(!tab.id)throw new Error('TAB_CREATE_FAILED');
    const now=Date.now(),id=crypto.randomUUID();
    try { await changeJobs(jobs=>{
      if(Object.values(jobs).filter(loginJobActive).length>=20)throw new Error('请先完成或取消正在等待的登录。');
      jobs[id]={id,tabId:tab.id!,credentialId:credential.id,vaultId:session.encryptedVault.kdf.salt,origin:target.origin,autoSubmit,phase:'loading',createdAt:now,updatedAt:now,expiresAt:now+60000};
    });
    await chrome.alarms.create(ALARM,{periodInMinutes:1});
    await chrome.tabs.update(tab.id,{url:credential.url});
    return {ok:true,queued:true};
    } catch(error) {
      await changeJobs(jobs=>{delete jobs[id];});
      await chrome.tabs.remove(tab.id).catch(()=>undefined);
      throw error;
    }
  };
}
