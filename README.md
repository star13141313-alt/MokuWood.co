# MokuWood.co

肆木代購會員專區 — LINE LIFF 靜態網站，部署於 GitHub Pages。

---

## 聊聊客服功能

### 架構

```
使用者 (GitHub Pages)
   │  匿名 Supabase Session (JWT)
   ▼
Supabase Auth  ────────────────────────────────────────┐
   │                                                   │
   │  1. 使用者訊息寫入 chat_messages (RLS 保護)         │
   ▼                                                   │
Supabase DB (chat_conversations / chat_messages)       │
   │                                                   │
   │  2. 呼叫 Edge Function（帶 JWT）                    │
   ▼                                                   │
Supabase Edge Function (gemini-chat)                   │
   │  • 驗證 JWT → 取得 user_id                        │
   │  • 驗證 conversation_id 屬於該 user               │
   │  • 從 DB 讀取歷史訊息                               │
   │  • 呼叫 Gemini API                                 │
   │  • AI 回覆寫回 chat_messages (service_role)        │
   ▼                                                   │
Gemini API                                             │
   │  回覆                                             │
   └──────────────────────────────────────────────────┘
                  返回給前端
```

### 安全狀態

| 項目 | 狀態 |
|------|------|
| Gemini API Key | ✅ 只存在 Supabase Secret，不進 GitHub / 前端 |
| service_role key | ✅ 只在 Edge Function 自動注入，不進 GitHub / 前端 |
| 前端 anon key | ✅ 公開設計，RLS 保護資料存取 |
| JWT 驗證 | ✅ Edge Function 驗證 Supabase Session |
| conversation 所有權 | ✅ Edge Function 驗證 conversation 屬於當前 user |
| 歷史訊息來源 | ✅ 從 DB 讀取，不信任前端傳來的 history |
| RLS | ✅ 顧客只能存取自己的 conversation / messages |
| Realtime | ✅ chat_messages 啟用，後台可即時收到訊息 |
| rate limit | ✅ 以 user_id 為 key，每分鐘最多 10 次 |

### 資料表

#### chat_conversations

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | 關聯 auth.users.id |
| created_at | timestamptz | 建立時間 |
| updated_at | timestamptz | 更新時間 |

#### chat_messages

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | uuid | PK |
| conversation_id | uuid | 關聯 chat_conversations.id |
| sender_type | text | user / ai / admin |
| message | text | 訊息內容 |
| created_at | timestamptz | 建立時間 |

### 部署步驟

#### 1. Supabase Dashboard — 建立資料表與 RLS

在 **SQL Editor** 貼上並執行 `supabase/migrations/20240101000000_chat_tables.sql`。

#### 2. 替換前端佔位符

開啟 `index.html`，找到：

```js
const SUPABASE_URL      = "https://YOUR_PROJECT_REF.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";
```

替換成您的 Supabase 專案 URL 和 **anon key**（不是 service_role key）。

> anon key 是公開設計，可以放在前端。RLS 政策保護資料存取。

#### 3. 安裝 Supabase CLI 並部署 Edge Function

```bash
# 安裝 Supabase CLI
npm install -g supabase

# 登入
supabase login

# 連結專案（替換 <project-ref>）
supabase link --project-ref <project-ref>

# 設定 Secrets（只設定這個，其他由 Supabase 自動注入）
supabase secrets set GEMINI_API_KEY=你的金鑰
supabase secrets set ALLOWED_ORIGIN=https://star13141313-alt.github.io

# 部署 Edge Function
supabase functions deploy gemini-chat
```

#### 4. Supabase Dashboard — 啟用 Anonymous Auth

Authentication > Providers > Anonymous Sign-ins → 開啟

#### 5. 確認 Realtime 已啟用

Database > Replication → 確認 `chat_messages` 出現在 `supabase_realtime` publication 中。
（SQL migration 已自動設定，此步驟僅供確認）

---

## 功能說明

| 分頁 | 說明 |
|------|------|
| 首頁 | 商品進度總覽、快速篩選 |
| 賣場 | 商品列表、品牌篩選、加入購物車、收藏 |
| 訂單 | 個人訂單記錄 |
| 會員資料 | 會員卡、收件資料、註冊 |
| 聊聊客服 | AI 客服（Gemini）+ 真人客服（LINE）|

