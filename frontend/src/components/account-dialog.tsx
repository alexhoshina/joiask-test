"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AccountUser,
  VerificationStatus,
  cancelAccountVerification,
  checkAccountVerification,
  getAccountVerification,
  loginAccount,
  registerAccount,
  startAccountVerification,
  requestPasswordReset,
} from "@/lib/api";

interface AccountDialogProps {
  open: boolean;
  emailEnabled: boolean;
  initialMode: "login" | "register";
  onClose: () => void;
  onAuthenticated: (user: AccountUser) => void;
}

export function AccountDialog({ open, ...props }: AccountDialogProps) {
  return open ? <AccountDialogContent key={props.initialMode} {...props} /> : null;
}

function AccountDialogContent({
  emailEnabled,
  initialMode,
  onClose,
  onAuthenticated,
}: Omit<AccountDialogProps, "open">) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">(
    initialMode,
  );
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [uid, setUid] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verification, setVerification] = useState<VerificationStatus | null>(
    null,
  );
  const [editingUid, setEditingUid] = useState(false);
  const [restore, setRestore] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");
  const [action, setAction] = useState<"submit" | "check" | "cancel" | null>(null);
  const busy = action !== null;
  const [now, setNow] = useState(Date.now);
  const deadline = verification?.status === "verified" ? verification.confirmation_until : verification?.expires_at;
  const remaining = deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : 0;

  useEffect(() => {
    if (mode !== "register" || restore !== "loading") return;
    const controller = new AbortController();
    getAccountVerification(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.code !== 200 && response.code !== 404) {
          setError(response.message || "无法读取验证进度");
          setRestore("failed");
          return;
        }
        const current = response.code === 200 && ["pending", "verified"].includes(response.data.status);
        setVerification(current ? response.data : null);
        setRestore("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("无法读取验证进度，请检查网络连接后重试");
        setRestore("failed");
      });
    return () => controller.abort();
  }, [mode, restore]);

  useEffect(() => {
    if (!verification) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [verification]);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setAction("submit");
    setError("");
    try {
      const response = await loginAccount(loginUsername, password);
      if (response.code === 200) onAuthenticated(response.data);
      else setError(response.message || "登录失败");
    } catch {
      setError("登录失败，请检查网络连接");
    } finally {
      setAction(null);
    }
  };

  const startVerification = async (event: React.FormEvent) => {
    event.preventDefault();
    setAction("submit");
    setError("");
    setMessage("");
    try {
      const response = await startAccountVerification(uid.trim());
      if (response.code === 200) {
        setVerification(response.data);
        setEditingUid(false);
        if (verification && response.data.bilibili_uid !== verification.bilibili_uid) {
          setLoginUsername("");
          setPassword("");
          setConfirmPassword("");
        }
      } else {
        setError(response.message || "无法开始验证");
      }
    } catch {
      setError("无法开始验证，请稍后重试");
    } finally {
      setAction(null);
    }
  };

  const handleRegister = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setAction("submit");
    setError("");
    try {
      const response = await registerAccount(loginUsername, password, verification?.bilibili_uid);
      if (response.code === 200) onAuthenticated(response.data);
      else setError(response.message || "注册失败");
    } catch {
      setError("注册失败，请稍后重试");
    } finally {
      setAction(null);
    }
  };

  const handleForgot = async (event: React.FormEvent) => {
    event.preventDefault();
    setAction("submit");
    setError("");
    setMessage("");
    try {
      const response = await requestPasswordReset(email);
      if (response.code === 200) setMessage(response.data.message);
      else setError(response.message || "请求失败");
    } catch {
      setError("请求失败，请检查网络连接");
    } finally {
      setAction(null);
    }
  };

  const resetRegister = () => {
    setVerification(null);
    setUid("");
    setEditingUid(false);
    setLoginUsername("");
    setMessage("");
    setPassword("");
    setConfirmPassword("");
    setError("");
  };

  const cancelVerification = async () => {
    if (!verification) return;
    setAction("cancel");
    setError("");
    setMessage("");
    try {
      const response = await cancelAccountVerification(verification.bilibili_uid);
      if (response.code === 200) resetRegister();
      else setError(response.message || "无法取消验证");
    } catch {
      setError("取消验证失败，请检查网络连接后重试");
    } finally {
      setAction(null);
    }
  };

  const checkSignature = async () => {
    setAction("check");
    setError("");
    setMessage("");
    try {
      const response = await checkAccountVerification();
      if (response.code === 200) setVerification(response.data);
      else setError(response.message || "暂时无法验证签名，请稍后重试");
    } catch {
      setError("验证请求失败，请检查网络连接后重试");
    } finally {
      setAction(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/45 px-4 py-8"
      onMouseDown={mode === "register" && busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="登录 / 注册"
        className="max-h-[calc(100dvh-4rem)] w-full max-w-[420px] overflow-y-auto rounded-md border-2 border-dashed border-[var(--color-fabric-stitch)] bg-card p-5 text-foreground shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex rounded-md bg-secondary p-1">
            <button
              disabled={busy}
              className={`rounded px-4 py-1.5 text-sm ${mode === "login" ? "bg-card shadow-sm" : "text-muted-foreground"}`}
              onClick={() => {
                if (mode === "login") return;
                setMode("login");
                resetRegister();
              }}
            >
              登录
            </button>
            <button
              disabled={busy}
              className={`rounded px-4 py-1.5 text-sm ${mode === "register" ? "bg-card shadow-sm" : "text-muted-foreground"}`}
              onClick={() => {
                if (mode === "register") return;
                resetRegister();
                setRestore("loading");
                setMode("register");
              }}
            >
              注册
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={mode === "register" && busy}
            className="flex h-9 w-9 items-center justify-center rounded hover:bg-secondary"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {mode === "forgot" && emailEnabled ? (
          <form className="space-y-4" onSubmit={handleForgot}>
            <div>
              <label htmlFor="reset-email" className="mb-1.5 block text-sm">
                已绑定的邮箱
              </label>
              <Input
                id="reset-email"
                type="email"
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <p className="text-sm text-muted-foreground">
              输入账号已绑定的邮箱，我们会向该邮箱发送重新设置密码的链接。
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {message && (
              <p role="status" className="text-sm text-primary">
                {message}
              </p>
            )}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "发送重置密码邮件"
              )}
            </Button>
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              disabled={busy}
              onClick={() => {
                setMode("login");
                resetRegister();
              }}
            >
              返回登录
            </button>
          </form>
        ) : mode === "login" || mode === "forgot" ? (
          <form className="space-y-4" onSubmit={handleLogin}>
            <div>
              <label
                htmlFor="login-identifier"
                className="mb-1.5 block text-sm"
              >
                登录名或邮箱
              </label>
              <Input
                id="login-identifier"
                placeholder="请输入登录名或已绑定邮箱"
                maxLength={254}
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm">密码</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "登录"}
            </Button>
            {emailEnabled && (
              <button
                type="button"
                disabled={busy}
                className="text-sm text-primary hover:underline"
                onClick={() => {
                  setMode("forgot");
                  setError("");
                  setMessage("");
                  setPassword("");
                }}
              >
                忘记密码？
              </button>
            )}
          </form>
        ) : restore === "loading" ? (
          <p role="status" className="text-sm">正在读取验证进度…</p>
        ) : restore === "failed" ? (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-destructive">{error}</p>
            <Button className="w-full" onClick={() => { setError(""); setRestore("loading"); }}>重新读取</Button>
          </div>
        ) : !verification || editingUid ? (
          <form className="space-y-4" onSubmit={startVerification}>
            <div>
              <label htmlFor="verification-uid" className="mb-1.5 block text-sm">
                {editingUid ? "新的 B 站 UID" : "你的 B 站 UID"}
              </label>
              <Input
                id="verification-uid"
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                inputMode="numeric"
                disabled={busy}
                required
              />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" type="submit" disabled={busy || (editingUid && uid.trim() === verification?.bilibili_uid)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : editingUid ? "验证新 UID" : "开始验证"}
            </Button>
            {editingUid && (
              <Button className="w-full" variant="outline" type="button" disabled={busy} onClick={() => {
                setEditingUid(false);
                setError("");
              }}>返回原验证</Button>
            )}
          </form>
        ) : verification.status === "pending" ? (
          <div className="space-y-4">
            <div className="rounded-md bg-secondary p-4 text-sm leading-6">
              请复制下方验证码，打开你的 B 站空间，暂时将个性签名改为这个验证码并保存。
              <a
                href={`https://space.bilibili.com/${verification.bilibili_uid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary underline underline-offset-2"
              >
                打开 UID {verification.bilibili_uid} 的空间
              </a>
            </div>
            <div className="flex items-center justify-between text-sm">
              <code className="select-all font-mono">{verification.challenge_code}</code>
              <Button variant="outline" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(verification.challenge_code || "");
                  setMessage("已复制验证码");
                } catch {
                  setMessage("请选择上方验证码并手动复制");
                }
              }}>复制验证码</Button>
            </div>
            {message && <p role="status" className="text-sm">{message}</p>}
            <p className="text-sm">验证码剩余 {remaining} 秒。验证通过后可以恢复原签名。</p>
            {remaining > 0 && <Button className="w-full" onClick={checkSignature} disabled={busy}>
              {action === "check" ? "正在验证…" : "我已修改签名，立即验证"}
            </Button>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {remaining === 0 && (
              <Button
                className="w-full"
                variant="outline"
                disabled={busy}
                onClick={resetRegister}
              >
                重新发起验证
              </Button>
            )}
          </div>
        ) : verification.status === "verified" && remaining > 0 ? (
          <form className="space-y-4" onSubmit={handleRegister}>
            <div className="rounded-md bg-secondary p-3">
              <div className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                {verification.bilibili_name}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                UID{" "}
                <a
                  href={`https://space.bilibili.com/${verification.bilibili_uid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {verification.bilibili_uid}
                </a>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm">设置登录名</label>
              <Input
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                minLength={2}
                maxLength={32}
                autoComplete="username"
                required
                placeholder="请输入登录名"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm">设置密码</label>
              <Input
                type="password"
                minLength={8}
                maxLength={72}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm">确认密码</label>
              <Input
                type="password"
                minLength={8}
                maxLength={72}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">
              请在 {Math.ceil(remaining / 60)} 分钟内完成注册
            </p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" type="submit" disabled={busy || remaining === 0}>
              {action === "submit" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "确认并创建账号"
              )}
            </Button>
          </form>
        ) : (
          <div className="space-y-4 text-center">
            <UserRound className="mx-auto h-8 w-8 text-muted-foreground" />
            <p>验证已过期，请重新发起。</p>
            <Button className="w-full" onClick={resetRegister} disabled={busy}>
              重新验证
            </Button>
          </div>
        )}
        {mode === "register" && restore === "ready" && verification && !editingUid && remaining > 0 && (
          <div className="mt-3 flex justify-between gap-3">
            <Button type="button" variant="link" disabled={busy} onClick={() => {
              setUid(verification.bilibili_uid);
              setEditingUid(true);
              setError("");
              setMessage("");
            }}>更换 UID</Button>
            <Button type="button" variant="link" disabled={busy} onClick={cancelVerification}>
              {action === "cancel" ? "正在取消…" : "取消验证"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
