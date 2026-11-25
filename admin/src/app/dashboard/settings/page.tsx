"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { type BilibiliProfilePreview, type EmailSettings, type Settings, getSettings, testBilibiliProfile, updateSettings } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type ProfileTest =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "success"; profile: BilibiliProfilePreview };

export default function SettingsPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const [profileURL, setProfileURL] = useState("");
  const [savedProfileURL, setSavedProfileURL] = useState("");
  const [testUid, setTestUid] = useState("");
  const [profileTest, setProfileTest] = useState<ProfileTest>({ status: "idle" });
  const [email, setEmail] = useState<EmailSettings>({
    enabled: false,
    host: "",
    port: 587,
    username: "",
    password: "",
    password_configured: false,
    security: "starttls",
    from_email: "",
    from_name: "",
    site_url: "",
  });
  const updateEmail = <K extends keyof EmailSettings>(
    key: K,
    value: EmailSettings[K],
  ) => setEmail((current) => ({ ...current, [key]: value }));
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [supportsVision, setSupportsVision] = useState(false);
  const [visionTestTimeout, setVisionTestTimeout] = useState("20");
  const [apiKey, setAPIKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [clearMailPassword, setClearMailPassword] = useState(false);
  const [spamPrompt, setSpamPrompt] = useState("");
  const [autoPublish, setAutoPublish] = useState(false);
  const [requireVerifiedUserToPost, setRequireVerifiedUserToPost] =
    useState(false);
  const [showAPIKey, setShowAPIKey] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);

  const showSettings = useCallback((settings: Settings) => {
    setEmail(settings.email);
    setProfileURL(settings.bilibili_profile_url);
    setSavedProfileURL(settings.bilibili_profile_url);
    setAPIKey("");
    setHasKey(settings.ai_api_key_configured);
    setClearKey(false);
    setClearMailPassword(false);
    setBaseURL(settings.ai_base_url);
    setModel(settings.ai_model);
    setSupportsVision(settings.ai_supports_vision);
    setVisionTestTimeout(String(settings.ai_vision_test_timeout_seconds));
    setSpamPrompt(settings.spam_prompt);
    setAutoPublish(settings.ai_auto_publish);
    setRequireVerifiedUserToPost(settings.require_verified_user_to_post);
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await getSettings();
        if (res.code === 200) {
          showSettings(res.data);
        } else {
          setMessage(res.message || "加载失败");
        }
      } catch {
        setMessage("加载失败");
      } finally {
        setIsLoading(false);
      }
    };

    loadSettings();
  }, [showSettings]);

  const handleProfileTest = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileTest({ status: "loading" });
    try {
      const response = await testBilibiliProfile(profileURL.trim(), testUid.trim());
      if (response.code === 200) setProfileTest({ status: "success", profile: response.data });
      else setProfileTest({ status: "error", message: response.message || "资料接口测试失败" });
    } catch {
      setProfileTest({ status: "error", message: "无法测试资料接口，请检查网络连接" });
    }
  };

  const handleSave = async () => {
    const timeoutSeconds = Number(visionTestTimeout);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
      setMessage("视觉测试超时必须是 1 至 300 之间的整数");
      setIsSuccess(false);
      return;
    }
    if (!spamPrompt.trim()) {
      setMessage("低质量提问判定标准不能为空");
      setIsSuccess(false);
      return;
    }
    setIsSaving(true);
    setMessage("");
    setIsSuccess(false);
    try {
      const res = await updateSettings({
        email: { ...email, password: clearMailPassword ? null : email.password },
        ...(isSuperAdmin && profileURL.trim() !== savedProfileURL && { bilibili_profile_url: profileURL.trim() }),
        ai_base_url: baseURL.trim(),
        ai_model: model.trim(),
        ai_supports_vision: supportsVision,
        ai_vision_test_timeout_seconds: timeoutSeconds,
        ai_api_key: clearKey ? null : apiKey.trim(),
        spam_prompt: spamPrompt.trim(),
        ai_auto_publish: autoPublish,
        require_verified_user_to_post: requireVerifiedUserToPost,
      });
      if (res.code === 200) {
        showSettings(res.data);
        setMessage("保存成功");
        setIsSuccess(true);
      } else {
        setMessage(res.message || "保存失败");
      }
    } catch {
      setMessage("保存失败");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          设置
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理投稿权限、邮件服务和内容审核
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>投稿权限</CardTitle>
          <CardDescription>
            控制游客是否可以直接投稿，不影响登录和注册入口。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-2xl items-start gap-3">
            <Checkbox
              id="require-verified-user"
              checked={requireVerifiedUserToPost}
              onCheckedChange={(checked) =>
                setRequireVerifiedUserToPost(!!checked)
              }
              disabled={isLoading}
            />
            <div className="space-y-1">
              <Label htmlFor="require-verified-user">投稿需要已验证用户</Label>
              <p className="text-sm text-muted-foreground">
                开启后仅已完成 B 站验证并登录的用户可以投稿。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {isSuperAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>B 站用户资料</CardTitle>
            <CardDescription>注册验证和后台创建用户时，会从此接口读取 B 站资料。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="max-w-2xl space-y-4" onSubmit={handleProfileTest}>
              <div className="space-y-2">
                <Label htmlFor="bilibili-profile-url">B 站用户资料接口地址</Label>
                <Input id="bilibili-profile-url" aria-describedby="bilibili-profile-url-help" type="url" required value={profileURL}
                  placeholder="https://bili.example.com/card" disabled={isLoading || isSaving || profileTest.status === "loading"}
                  onChange={(event) => { setProfileURL(event.target.value); setProfileTest({ status: "idle" }); }} />
                <p id="bilibili-profile-url-help" className="break-words text-sm text-muted-foreground">
                  默认地址为 <code>https://api.bilibili.com/x/web-interface/card</code>。使用自建接口时填写完整的 HTTPS 地址，Worker 会自动附加 <code>mid</code> 查询参数。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bilibili-test-uid">测试用 B 站 UID</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input id="bilibili-test-uid" className="max-w-xs" inputMode="numeric" pattern="[0-9]{1,19}" maxLength={19}
                    required value={testUid} disabled={isLoading || isSaving || profileTest.status === "loading"}
                    onChange={(event) => { setTestUid(event.target.value); setProfileTest({ status: "idle" }); }} />
                  <Button type="submit" variant="outline"
                    disabled={isLoading || isSaving || profileTest.status === "loading" || !profileURL.trim() || !testUid.trim()}>
                    {profileTest.status === "loading" ? "正在读取…" : "测试连接"}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">测试使用当前输入的地址。点击页面底部的“保存设置”后，新地址才会生效。</p>
              </div>
              {profileTest.status === "error" && <p role="alert" className="text-sm text-destructive">{profileTest.message}</p>}
              {profileTest.status === "success" && (
                <div role="status" className="rounded-md bg-muted p-3 text-sm">
                  <p className="break-words font-medium">{profileTest.profile.name}（UID {profileTest.profile.uid}）</p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{profileTest.profile.signature || "暂无个性签名"}</p>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>邮件服务（SMTP）</CardTitle>
          <CardDescription>
            开启后，已注册用户可以绑定邮箱，并通过邮件链接重置密码。注册流程保持不变。
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-3xl space-y-5">
          <div className="flex items-center gap-3">
            <Checkbox
              id="email-enabled"
              checked={email.enabled}
              onCheckedChange={(checked) => updateEmail("enabled", !!checked)}
              disabled={isLoading || isSaving}
            />
            <Label htmlFor="email-enabled">开启邮件功能</Label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="smtp-host">SMTP 主机</Label>
              <Input
                id="smtp-host"
                value={email.host}
                onChange={(e) => updateEmail("host", e.target.value)}
                placeholder="smtp.example.com"
                disabled={isLoading || isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-port">SMTP 端口</Label>
              <Input
                id="smtp-port"
                type="number"
                min={1}
                max={65535}
                value={email.port || ""}
                onChange={(e) => updateEmail("port", Number(e.target.value))}
                disabled={isLoading || isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-security">连接加密</Label>
              <select
                id="smtp-security"
                value={email.security}
                onChange={(e) =>
                  updateEmail(
                    "security",
                    e.target.value as EmailSettings["security"],
                  )
                }
                disabled={isLoading || isSaving}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="starttls">STARTTLS（通常为 587）</option>
                <option value="tls">TLS / SSL（通常为 465）</option>

              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-username">SMTP 用户名</Label>
              <Input
                id="smtp-username"
                value={email.username}
                onChange={(e) => updateEmail("username", e.target.value)}
                autoComplete="off"
                placeholder="可留空以使用无需认证的中继"
                disabled={isLoading || isSaving}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="smtp-password">SMTP 密码 / 授权码</Label>
              <Input
                id="smtp-password"
                type="password"
                value={email.password}
                onChange={(e) => { setClearMailPassword(false); updateEmail("password", e.target.value); }}
                autoComplete="new-password"
                placeholder={
                  email.password_configured && !clearMailPassword
                    ? "已配置，留空保留现有密码"
                    : "请输入 SMTP 密码或授权码"
                }
                disabled={isLoading || isSaving}
              />
              <p className="text-xs text-muted-foreground">
                {email.password_configured && <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={clearMailPassword} onChange={(event) => {
                    setClearMailPassword(event.target.checked);
                    updateEmail("password", "");
                  }} />
                  清除已保存的 SMTP 密码
                </label>}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-from-email">发件邮箱</Label>
              <Input
                id="smtp-from-email"
                type="email"
                value={email.from_email}
                onChange={(e) => updateEmail("from_email", e.target.value)}
                placeholder="noreply@example.com"
                disabled={isLoading || isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-from-name">发件人名称</Label>
              <Input
                id="smtp-from-name"
                value={email.from_name}
                onChange={(e) => updateEmail("from_name", e.target.value)}
                placeholder="JoiAsk 提问箱"
                disabled={isLoading || isSaving}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="email-site-url">网站公开地址</Label>
              <Input
                id="email-site-url"
                type="url"
                value={email.site_url}
                onChange={(e) => updateEmail("site_url", e.target.value)}
                placeholder="https://ask.example.com"
                disabled={isLoading || isSaving}
              />
              <p className="text-xs text-muted-foreground">
                填写用户访问前台的完整地址，用于生成邮件链接。链接有效期为 30
                分钟。关闭邮件功能后，相关入口隐藏，已有邮件链接也暂不可用。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>内容审核服务</CardTitle>
          <CardDescription>
            配置支持 Chat Completions 的服务地址、模型与 API 密钥。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ai-base-url">API 基础地址</Label>
            <Input id="ai-base-url" type="url" value={baseURL} onChange={(event) => {
              if (event.target.value.trim() !== baseURL.trim()) setSupportsVision(false);
              setBaseURL(event.target.value);
            }} placeholder="https://api.example.com/v1" disabled={isLoading || isSaving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-model">模型名称</Label>
            <Input id="ai-model" value={model} onChange={(event) => {
              if (event.target.value.trim() !== model.trim()) setSupportsVision(false);
              setModel(event.target.value);
            }} disabled={isLoading || isSaving} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Checkbox
                id="ai-supports-vision"
                aria-describedby="ai-supports-vision-help"
                checked={supportsVision}
                onCheckedChange={(checked) => setSupportsVision(checked === true)}
                disabled={isLoading || isSaving}
              />
              <Label htmlFor="ai-supports-vision">当前模型支持图片输入</Label>
            </div>
            <p id="ai-supports-vision-help" className="text-sm text-muted-foreground">
              请仅为支持图片输入的模型开启。勾选并保存时，系统会向当前模型发送一张不含投稿内容的测试图。验证通过后，投稿图片会随文字一起发送给模型审核。
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-vision-test-timeout">视觉测试超时（秒）</Label>
            <Input
              id="ai-vision-test-timeout"
              aria-describedby="ai-vision-test-timeout-help"
              className="max-w-32"
              type="number"
              min={1}
              max={300}
              step={1}
              required
              value={visionTestTimeout}
              onChange={(event) => setVisionTestTimeout(event.target.value)}
              disabled={isLoading || isSaving}
            />
            <p id="ai-vision-test-timeout-help" className="text-sm text-muted-foreground">
              设置等待模型识别测试图的时长，可填 1 至 300 秒，默认 20 秒。
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-api-key">API 密钥</Label>
            <div className="relative max-w-2xl">
              <Input
                id="ai-api-key"
                type={showAPIKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => { setAPIKey(event.target.value); setClearKey(false); }}
                placeholder={hasKey && !clearKey ? "已配置，留空保留" : "输入 API 密钥"}
                autoComplete="off"
                disabled={isLoading}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowAPIKey((value) => !value)}
                disabled={isLoading}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={showAPIKey ? "隐藏 API Key" : "显示 API Key"}
              >
                {showAPIKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="text-sm text-muted-foreground">
              {hasKey && <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setAPIKey(""); }} />
                清除已保存的密钥
              </label>}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="spam-prompt">低质量提问判定标准</Label>
            <Textarea
              id="spam-prompt"
              value={spamPrompt}
              onChange={(event) => setSpamPrompt(event.target.value)}
              placeholder={"例如：\n广告或恶意引流\n重复灌水\n明显无意义的内容"}
              rows={8}
              disabled={isLoading}
              className="max-w-2xl"
            />
            <p className="text-sm text-muted-foreground">
              只需描述什么样的提问属于低质量内容，无需编写“请判断”等任务说明。
              审核逻辑、输入字段说明和 is_spam JSON 返回格式由系统自动补充。
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>审核自动公开</CardTitle>
        </CardHeader>
        <CardContent className="max-w-2xl space-y-2">
          <div className="flex items-center gap-3">
            <Checkbox
              id="ai-auto-publish"
              aria-describedby="ai-auto-publish-help"
              checked={autoPublish}
              onCheckedChange={(checked) => setAutoPublish(checked === true)}
              disabled={isLoading || isSaving}
            />
            <Label htmlFor="ai-auto-publish">自动公开 AI 判定为正常的提问</Label>
          </div>
          <p id="ai-auto-publish-help" className="text-sm text-muted-foreground">
            开启后，纯文字提问通过 AI 审核即可公开。含图提问需文字和图片均通过审核才能自动公开。未开启图片输入时，正文正常的含图提问仍留在收件箱，等待人工看图。
          </p>
          <p className="text-sm text-muted-foreground">
            低质量提问进入拦截箱。审核服务未配置或审核失败时，提问留在收件箱，等待人工处理。
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={handleSave} disabled={isLoading || isSaving || profileTest.status === "loading"}>
          {isLoading ? "加载中..." : isSaving ? "保存中..." : "保存设置"}
        </Button>
        {message && (
          <p className={isSuccess ? "text-[#6b7d6b]" : "text-destructive"}>
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
