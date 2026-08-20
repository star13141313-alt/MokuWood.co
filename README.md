# MokuWood.co

肆木代購會員專區 — LINE LIFF 靜態網站，部署於 GitHub Pages。

---

## 聊聊客服功能

### 架構

```
使用者 (GitHub Pages)
   │
   ▼
Supabase Edge Function (gemini-chat)
   │
   ▼
Gemini API
```

### 目前安全狀態

- Gemini API Key 只放在 Supabase Secret，不放 GitHub 或前端。
- Edge Function 僅接受設定好的 GitHub Pages Origin。
- 非允許 Origin 直接回傳 403。
- 限制單次訊息長度、歷史訊息數與 request body 大小。
- 加入 best-effort rate limit，避免公開端點被大量連續呼叫。
- Edge Function 尚未部署到正式環境；在前端加入 Supabase Session/JWT 驗證前，不應把它視為完整的身份驗證方案。

### Gemini 免費方案

Google Gemini API 目前提供部分模型的免費輸入／輸出額度；實際可用模型與限制以 Google 官方價格頁為準。

目前程式使用 `gemini-3.5-flash-lite`，不要使用已停止服務的 Gemini 1.x / 2.0 舊模型。

### 部署步驟

> **先不要部署。** 正式上線前需要先讓 GitHub Pages 前端建立 Supabase Session，並讓 Edge Function 驗證 JWT。這一步完成後才會符合 MokuWood 的「安全優先」要求。

```bash
# 安裝 Supabase CLI
npm install -g supabase

# 登入
supabase login

# 連結專案（替換 <project-ref>）
supabase link --project-ref <project-ref>

# 設定 Secrets
supabase secrets set GEMINI_API_KEY=你的金鑰
supabase secrets set ALLOWED_ORIGIN=https://star13141313-alt.github.io
```

**不要使用 `--no-verify-jwt` 直接把 AI endpoint 公開後就上線。**

### 前端 URL

完成 Supabase Session/JWT 驗證後，再將 `index.html` 的：

```js
const CHAT_EDGE_URL =
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/gemini-chat";
```

替換成實際 Supabase Function URL。

---

## 功能說明

| 分頁 | 說明 |
|------|------|
| 首頁 | 商品進度總覽、快速篩選 |
| 賣場 | 商品列表、品牌篩選、加入購物車、收藏 |
| 訂單 | 個人訂單記錄 |
| 會員資料 | 會員卡、收件資料、註冊 |
| 聊聊客服 | AI 客服（Gemini）+ 真人客服（LINE） |
