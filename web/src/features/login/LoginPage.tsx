import { FormEvent, type ReactNode, useState } from "react";
import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import type { StaffIdentity } from "../../shared/AppShell";
import { Brand, Icon } from "../../shared/Icons";

function DentalArch() {
  // Paired teeth follow the curvature of the upper arch.
  const half = [[46, 18, 12], [38, 20, -11], [30, 25, -34], [25, 33, -45],
    [20, 43, -35], [16, 54, -24], [13, 66, -14], [11, 78, -9]];
  return <div className="dental-arch" aria-hidden="true">
    <div className="arch-orbit"/><div className="arch-axis"/>{half.map(([x, y, angle], index) =>
      [-1, 1].map(side => <i key={side + "/" + index} className={"arch-tooth tooth-shape-" + index}
        style={{left: (side < 0 ? x : 100 - x) + "%", top: y + "%", transform: "translate(-50%, -50%) rotate(" + angle * -side + "deg)"}}/>))}
    <span className="arch-center"><Icon name="tooth" size={36}/></span>
  </div>;
}
export function LoginPage({ onLogin, sample }: { onLogin: (identity: StaffIdentity) => void; sample?: ReactNode }) {
  const request = useApiRequest();
  const [loginIdentity, setLoginIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true); setError("");
    try {
      const identity = await request<StaffIdentity>("/auth/web/login", {
        method: "POST", body: { login_identity: loginIdentity, password },
      });
      onLogin(identity);
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : "无法登录，请重试。"); }
    finally { setSubmitting(false); }
  }
  return <main className="sign-in-page">
    <section className="login-identity"><Brand /><div className="login-poster">
      <p className="login-kicker">ANDREW DENTAL CLINICS</p><h2>连锁诊所<br/>管理系统</h2>
      <DentalArch /></div><div className="poster-foot"><span/>ADC · 安德鲁牙科</div>
    </section>
    <section className="login-pane">{sample ? <div className="sign-in">{sample}</div> : <form className="sign-in" onSubmit={submit}>
      <span className="signin-emblem"><Icon name="lock" size={22}/></span><h1>员工登录</h1>
      <p className="login-summary">使用工作账号进入诊所工作台。</p>
      <label htmlFor="login-identity">工作账号</label><div className="signin-field"><Icon name="user" size={18}/>
        <input id="login-identity" value={loginIdentity} onChange={e => setLoginIdentity(e.target.value)} placeholder="请输入工作账号"
          autoComplete="username" required /></div>
      <label htmlFor="login-password">密码</label><div className="signin-field"><Icon name="lock" size={18}/>
        <input id="login-password" type={visible ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
          placeholder="请输入密码" autoComplete="current-password" required />
        <button type="button" className="password-toggle" onClick={() => setVisible(!visible)} aria-label={visible ? "隐藏密码" : "显示密码"}>
          <Icon name={visible ? "eyeOff" : "eye"} size={19}/></button></div>
      {error && <p role="alert" className="error-text">{error}</p>}
      <button className="button primary signin-submit" type="submit" disabled={submitting}>{submitting ? "登录中…" : "登录"}<Icon name="arrow" size={18}/></button>
    </form>}</section>
  </main>;
}
