# MokuWood.co

肆木代購會員專區 — LINE LIFF 靜態網站，部署於 GitHub Pages。

---

## 聊聊客服功能

### 架構

```
使用者 (GitHub Pages)
   │  POST { history }
   ▼
Supabase Edge Function  (gemini-chat)
   │  POST Gemini API
   ▼
Google Gemini 1.5 Flash (免費額度)
```

### 部署步驟

#### 1. 取得 Gemini API Key

1. 前往 [Google AI Studio](https://aistudio.google.com/app/apikey)
2. 建立 API Key（免費，`gemini-1.5-flash` 每分鐘 15 次請求）

#### 2. 部署 Supabase Edge Function

```bash
# 安裝 Supabase CLI
npm install -g supabase

# 登入
supabase login

# 連結專案（替換 <project-ref>）
supabase link --project-ref <project-ref>

# 設定 Secret
supabase secrets set GEMINI_API_KEY=你的金鑰

# 部署
supabase functions deploy gemini-chat --no-verify-jwt
```

> `--no-verify-jwt` 讓 GitHub Pages 前端無需 Supabase JWT 即可呼叫。

#### 3. 更新前端 URL

編輯 `index.html`，將以下常數改為你的 Supabase 專案 URL：

```js
const CHAT_EDGE_URL =
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/gemini-chat";
```

替換 `YOUR_PROJECT_REF` 為實際的 Supabase 專案參考 ID。

---

## 功能說明

| 分頁 | 說明 |
|------|------|
| 首頁 | 商品進度總覽、快速篩選 |
| 賣場 | 商品列表、品牌篩選、加入購物車、收藏 |
| 訂單 | 個人訂單記錄 |
| 會員資料 | 會員卡、收件資料、註冊 |
| 聊聊客服 | AI 客服（Gemini）+ 真人客服（LINE） |
