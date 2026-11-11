import { t } from './i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, X } from 'lucide-react';
import { buildTotpImportPreview, parseTotpImport, type TotpImportAccount, type TotpImportSource } from './totpImport';
import type { TotpAccount } from './types';

export default function TotpImportPanel({ existing, onImport, onCancel }: {
  existing: TotpAccount[];
  onImport: (accounts: TotpImportAccount[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [sources, setSources] = useState<TotpImportSource[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const alive = useRef(true), processing = useRef(false);
  useEffect(() => { alive.current = true; panel.current?.focus({ preventScroll: true }); return () => { alive.current = false; }; }, []);
  const preview = useMemo(() => buildTotpImportPreview(sources, existing), [sources, existing]);
  const selectable = preview.rows.filter(row => !row.duplicate);
  const selected = selectable.filter(row => !excluded.has(row.id));
  const incomplete = preview.batches.some(batch => batch.read < batch.size);
  const warnings = sources.flatMap(source => source.result.warnings.map(warning => `${source.label}：${warning}`));

  function append(inputs: { text: string; label: string }[], priorErrors: string[] = []) {
    const added: TotpImportSource[] = [], failures = [...priorErrors];
    for (const input of inputs) {
      try { added.push({ id: crypto.randomUUID(), label: input.label, result: parseTotpImport(input.text) }); }
      catch (error) { failures.push(`${input.label}：${error instanceof Error ? t(error.message) : t("无法读取内容。")}`); }
    }
    if (!alive.current) return;
    if (sources.length + added.length > 100 || preview.rows.length + added.reduce((count, source) => count + source.result.accounts.length, 0) > 1000) {
      setErrors([t("一次最多预览 100 个二维码、1000 个账号，请先完成这一批。")]); return;
    }
    setSources(current => [...current, ...added]); setErrors(failures); setAcknowledged(false);
  }
  async function files(items: File[]) {
    if (processing.current || camera || !items.length) return;
    if (items.length > 20) { setErrors([t("一次最多选择 20 个文件，请分批添加。")]); return; }
    processing.current = true; setBusy(true); setErrors([]);
    const inputs: { text: string; label: string }[] = [], failures: string[] = [];
    try {
      for (const [index, file] of items.entries()) {
        if (!alive.current) return;
        // Use ordinal labels: filenames can contain private account details or URI secrets.
        const label = t("文件 {0}", [sources.length + index + 1]);
        try {
          if (file.type.startsWith('image/')) {
            const { readQrImage } = await import('./qrImport');
            const codes = await readQrImage(file);
            inputs.push(...codes.map((value, codeIndex) => ({ text: value, label: t("{0} · 二维码 {1}", [label, codeIndex + 1]) })));
          } else if (/\.txt$/i.test(file.name)) {
            if (file.size > 1024 * 1024) throw new Error(t("文本文件不能超过 1 MB。"));
            const lines = (await file.text()).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            if (lines.length > 100) throw new Error(t("一个文件最多包含 100 行验证器链接。"));
            inputs.push(...lines.map((value, lineIndex) => ({ text: value, label: t("{0} · 第 {1} 行", [label, lineIndex + 1]) })));
            if (!lines.length) throw new Error(t("文件中没有验证器链接。"));
          } else throw new Error(t("请选择二维码图片或每行一个链接的 TXT 文件。"));
        } catch (error) { failures.push(`${label}：${error instanceof Error ? t(error.message) : t("读取失败。")}`); }
      }
      append(inputs, failures);
    } finally { processing.current = false; if (alive.current) setBusy(false); }
  }
  function readText() {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 100) { setErrors([t("请粘贴 1–100 行验证器链接，每行一个。")]); return; }
    append(lines.map((value, index) => ({ text: value, label: t("链接 {0}", [sources.length + index + 1]) })));
    setText('');
  }
  async function commit() {
    if (processing.current || camera || incomplete || !selected.length || (warnings.length && !acknowledged)) return;
    processing.current = true; setBusy(true); setErrors([]);
    try { await onImport(selected.map(row => row.account)); }
    catch { if (alive.current) setErrors([t("导入失败，密码库可能已锁定或发生变化，请重新解锁后重试。")]); }
    finally { processing.current = false; if (alive.current) setBusy(false); }
  }
  return <section ref={panel} tabIndex={-1} className="kp-totp-import" aria-label={t("导入验证器")} onPaste={event => {
    const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (images.length) { event.preventDefault(); void files(images); }
  }}>
    <div className="kp-totp-import-heading"><h3>{t("导入二维码")}</h3><button type="button" aria-label={t("关闭导入")} disabled={busy} onClick={onCancel}><X size={18} /></button></div>
    <p className="kp-totp-help">{t("支持 Google 身份验证器导出的二维码，以及网站提供的标准验证器二维码。图片在本地读取。")}</p>
    <div className="kp-totp-import-tools">
      <button type="button" disabled={busy || camera} onClick={() => fileInput.current?.click()}><ImagePlus size={18} />{t("选择二维码图片")}</button>
      <button type="button" disabled={busy || camera} onClick={() => { setCamera(true); setErrors([]); }}><Camera size={18} />{t("摄像头扫描")}</button>
      <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/bmp,.txt" aria-label={t("二维码图片或链接文件")} hidden onChange={event => { const chosen = Array.from(event.target.files ?? []); event.target.value = ''; void files(chosen); }} />
    </div>
    <p className="kp-totp-help">{t("也可以在这里粘贴二维码图片。Google 导出了多张时，请依次添加全部二维码。")}</p>
    {camera && <QrCamera onRead={values => { append(values.map((value, index) => ({ text: value, label: t("扫描 {0}", [sources.length + index + 1]) }))); setCamera(false); }} onClose={() => setCamera(false)} />}
    <details className="kp-totp-import-links"><summary>{t("粘贴验证器链接 / 导入 TXT")}</summary>
      <label>{t("验证器链接")}<textarea value={text} maxLength={100000} autoComplete="off" spellCheck={false} onChange={event => setText(event.target.value)} placeholder={t("otpauth://totp/… 或 otpauth-migration://offline?data=…，每行一个")} /></label>
      <button type="button" disabled={busy || camera || !text.trim()} onClick={readText}>{t("读取链接")}</button>
      <p className="kp-totp-help">{t("TXT 文件可从上方选择文件导入。单个密钥请返回“添加验证码”。")}</p>
    </details>
    {busy && <p role="status">{t("正在处理，请稍候…")}</p>}
    {errors.length > 0 && <div role="alert" className="kp-totp-import-errors">{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
    {preview.batches.map((batch, index) => <p key={index} className="kp-totp-import-progress" role="status">{t("Google 迁移 ")}{preview.batches.length > 1 ? index + 1 : ''}{t("：已读取 ")}{batch.read} / {batch.size}{t(" 张")}{batch.read < batch.size ? t("，请继续添加剩余二维码。") : t("，已齐全。")}</p>)}
    {!!warnings.length && <div className="kp-totp-import-warnings"><p>{t("以下账号未加入导入列表：")}</p>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}<label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{t("我已了解，仅导入支持的账号")}</label></div>}
    {!!preview.rows.length && <>
      <div className="kp-totp-import-selection"><label><input type="checkbox" aria-label={t("选择全部可导入账号")} checked={!!selectable.length && selected.length === selectable.length} disabled={!selectable.length || busy || camera} onChange={event => setExcluded(event.target.checked ? new Set() : new Set(selectable.map(row => row.id)))} />{t("已选择 ")}{selected.length}{t(" 个账号")}</label><button type="button" disabled={busy || camera} onClick={() => { setSources([]); setExcluded(new Set()); setErrors([]); }}>{t("清空预览")}</button></div>
      <ul className="kp-totp-import-list">{preview.rows.map(row => <li key={row.id}><label>
        <input type="checkbox" checked={!row.duplicate && !excluded.has(row.id)} disabled={!!row.duplicate || busy || camera} onChange={event => setExcluded(current => { const next = new Set(current); if (event.target.checked) next.delete(row.id); else next.add(row.id); return next; })} aria-label={t("导入 {0} {1}", [row.account.issuer, row.account.account])} />
        <span><strong>{row.account.issuer || row.account.account}</strong>{row.account.issuer && <span>{row.account.account}</span>}<small>{row.account.algorithm} · {row.account.digits}{t(" 位 · ")}{row.account.period}{t(" 秒")}{row.duplicate ? ` · ${row.duplicate}` : ''}</small></span>
      </label></li>)}</ul>
    </>}
    <footer><button type="button" disabled={busy} onClick={onCancel}>{t("取消")}</button><button type="button" className="primary" disabled={busy || camera || incomplete || !selected.length || (!!warnings.length && !acknowledged)} onClick={() => void commit()}>{t("导入所选（")}{selected.length}）</button></footer>
  </section>;
}

function QrCamera({ onRead, onClose }: { onRead: (values: string[]) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onRead, onClose }); callbacks.current = { onRead, onClose };
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, stream: MediaStream | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { disposed = true; clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); if (video.current) video.current.srcObject = null; };
    const hide = () => { if (document.hidden) { stop(); callbacks.current.onClose(); } };
    document.addEventListener('visibilitychange', hide);
    void (async () => {
      try {
        const decoder = await import('./qrImport');
        if (disposed) return;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('UNAVAILABLE');
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (disposed || !video.current) { stop(); return; }
        video.current.srcObject = stream; await video.current.play();
        if (disposed) return;
        const scan = () => {
          if (disposed || !video.current) return;
          try {
            if (video.current.readyState >= 2) {
              const found = decoder.decodeQrPixels(decoder.qrPixels(video.current, video.current.videoWidth, video.current.videoHeight, 1400), false);
              if (found.length) { stop(); callbacks.current.onRead(found); return; }
            }
            timer = setTimeout(scan, 350);
          } catch { stop(); setError(t("摄像头画面无法读取，请关闭后重试或选择二维码图片。")); }
        };
        scan();
      } catch (reason) {
        if (disposed) return;
        stop();
        setError(reason instanceof DOMException && reason.name === 'NotAllowedError'
          ? t("未获得摄像头权限。请允许访问后重试，或使用二维码图片导入。")
          : t("摄像头无法启动。请检查设备是否被占用，或使用二维码图片导入。"));
      }
    })();
    return () => { stop(); document.removeEventListener('visibilitychange', hide); };
  }, []);
  return <div className="kp-totp-camera"><video ref={video} muted playsInline aria-label={t("二维码扫描画面")} />
    {error ? <p role="alert">{error}</p> : <p>{t("将手机上的完整二维码对准摄像头，识别后会自动停止。")}</p>}
    <button type="button" onClick={onClose}>{t("关闭摄像头")}</button>
  </div>;
}
