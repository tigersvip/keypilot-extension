import { t, getLanguage } from '../shared/i18n';
import { initLanguage } from '../shared/i18n';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShieldAlert, CheckCircle2, ArrowUpRight, LockKeyhole } from 'lucide-react';
import { LOGIN_JOBS_KEY, loginJobActive, loginJobHeading, type PublicLoginJob } from '../shared/loginJob';
import './style.css';
function LoginStatus() {
  const id=new URLSearchParams(location.search).get('job');
  const [job,setJob]=useState<PublicLoginJob|null>(),[error,setError]=useState('');
  async function request(type='KEYPILOT_LOGIN_STATUS') {
    try { const result=await chrome.runtime.sendMessage({type,id});if(!result?.ok)throw new Error();setJob(result.job);setError(''); }
    catch {setError(t("暂时无法读取登录状态，请重新打开插件。"));}
  }
  useEffect(()=>{
    void request();
    const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area==='session'&&changes[LOGIN_JOBS_KEY])void request();};
    chrome.storage.onChanged.addListener(changed);
    const timer=setInterval(()=>void request(),15000);
    return()=>{chrome.storage.onChanged.removeListener(changed);clearInterval(timer);};
  },[]);
  return <main className="login-status">
    <header><img src="icons/icon32.png" alt="" /><strong>KeyPilot</strong><span>{t("登录状态")}</span></header>
    <section aria-live="polite">
      <span className={`status-icon ${job?.phase==='done'?'success':''}`}>{job?.phase==='done'?<CheckCircle2 size={28}/>:job?.phase==='locked'?<LockKeyhole size={28}/>:<ShieldAlert size={28}/>}</span>
      <h1>{job?t(loginJobHeading(job)):job===null?t("本次登录任务已结束"):t("正在读取登录状态…")}</h1>
      {job&&<><p className="site">{job.origin}</p><p>{job.message?t(job.message):t("正在等待网页加载，完成后自动填写。")}</p>
        {job.phase==='certificate'&&<div className="status-help"><p>{t("请返回网站，核实服务器并处理 Chrome 的证书警告。网页正常打开后，KeyPilot 会核对地址并继续。")}</p><code>{job.certificateError}</code></div>}
        {loginJobActive(job)&&<p className="muted">{t("本次操作保留至 ")}{new Date(job.expiresAt).toLocaleTimeString(getLanguage(),{hour:'2-digit',minute:'2-digit',hour12:false})}{t("。关闭提示窗口不会取消等待。")}</p>}
      </>}
      {job===null&&<p>{t("需要登录时，请在密码库重新选择账号。")}</p>}
    </section>
    {error&&<p role="alert" className="error">{error}</p>}
    <footer>{job&&<button className="primary" onClick={()=>void request('KEYPILOT_LOGIN_RETURN')}><ArrowUpRight size={17}/>{t("返回网站")}</button>}
      {job?.phase==='locked'&&<button onClick={()=>void chrome.tabs.create({url:chrome.runtime.getURL('vault.html')})}>{t("解锁密码库")}</button>}
      {job&&loginJobActive(job)?<button disabled={job.phase==='filling'} onClick={()=>void request('KEYPILOT_LOGIN_CANCEL')}>{job.phase==='filling'?t("正在填写…"):t("取消本次登录")}</button>:<button onClick={()=>window.close()}>{t("关闭")}</button>}
    </footer>
  </main>;
}
void initLanguage().then(() => { createRoot(document.getElementById('root')!).render(<LoginStatus/>); });
