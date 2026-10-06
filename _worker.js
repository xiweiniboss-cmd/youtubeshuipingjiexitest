// YouTube 解析下载站（Cloudflare Pages 单文件 Worker）
// 根目录放 _worker.js：/api/* 走这里，其余走 env.ASSETS 静态资源
// 解析通道：RedFoxHub /story/api/parseWork/videoDownload/youtube
// 需要环境变量 REDFOX_API_KEY（与小红书/抖音站同一个 key，直接复用）
// 反馈系统：KV 绑定 FEEDBACK_KV、R2 绑定 FEEDBACK_BUCKET、环境变量 FEEDBACK_ADMIN_KEY
//   （与小红书站/TikTok站/抖音站共用同一套 KV/R2/管理密码）
// 人机验证：TURNSTILE_SITE_KEY（公开）+ TURNSTILE_SECRET_KEY（保密），各站共用同一套

const REDFOX_BASE = 'https://redfox.hk';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

// Cloudflare Turnstile 人机验证：secret 配了才校验，不配则跳过（向后兼容）
async function verifyTurnstile(token, secret, ip) {
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
    });
    const j = await resp.json();
    return j && j.success === true;
  } catch {
    return false;
  }
}

// ---------- RedFoxHub ----------
async function redfoxPost(path, apiKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(REDFOX_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        REDFOX_API_KEY: apiKey,
        'X-API-KEY': apiKey,
        'User-Agent': UA_PC,
        Accept: 'application/json',
      },
      body: JSON.stringify({ ...body, source: 'youtube-dl-pages' }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error('RedFoxHub 返回了非 JSON 数据（HTTP ' + resp.status + '）');
    }
    if (resp.status === 401)
      throw new Error('RedFoxHub API Key 无效，请检查环境变量 REDFOX_API_KEY 是否正确');
    if (resp.status === 429) throw new Error('请求太频繁，请稍后重试');
    const code = j.code;
    const msg = String(j.msg || j.message || '');
    // 成功码以 2 开头（如 200、2000），其余为错误
    if (code !== undefined && code !== null && !String(code).startsWith('2')) {
      if (code === 401 || code === 4001 || code === 3106 || code === 3107)
        throw new Error('RedFoxHub 鉴权失败：' + (msg || '请检查 REDFOX_API_KEY'));
      if (/余额|balance|insufficient|欠费/i.test(msg))
        throw new Error('RedFoxHub 余额不足，请前往 redfox.hk 控制台充值后再试');
      throw new Error('RedFoxHub：' + (msg || 'code=' + code));
    }
    if (!resp.ok) throw new Error('RedFoxHub 请求失败（HTTP ' + resp.status + '）' + (msg ? '：' + msg : ''));
    return j.data !== undefined ? j.data : j;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 链接处理 ----------
function extractYoutubeUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[.,;!?\]]+$/, '') : null;
}

// 提取 video id，支持 watch?v=、youtu.be/、shorts/、embed/、music.youtube.com 等
function extractVideoId(url) {
  const s = String(url || '');
  let m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/youtube\.com\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

// ---------- 结果提取 ----------
// YouTube 返回 resources: [{type, durationSeconds, downloadUrl, coverUrl}]
// 保留 type/duration 信息供前端展示清晰度
function ensureHttps(u) {
  if (typeof u !== 'string') return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}
function extractResources(data) {
  const out = [];
  const seen = new Set();
  const list = data.resources || data.resource || data.medias || [];
  if (Array.isArray(list)) {
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const url = ensureHttps(r.downloadUrl || r.download_url || r.url || '');
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        type: String(r.type || 'video'),
        duration: typeof r.durationSeconds === 'number' ? r.durationSeconds : null,
        cover: ensureHttps(r.coverUrl || r.cover_url || ''),
      });
    }
  }
  // 兼容：没有 resources 数组时从顶层字段兜底
  if (!out.length) {
    for (const k of ['videoUrl', 'video_url', 'downloadUrl', 'download_url', 'url']) {
      const url = ensureHttps(data[k] || '');
      if (typeof url === 'string' && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push({ url, type: 'video', duration: null, cover: '' });
      }
    }
  }
  return out;
}

async function parseYoutubeViaRedFox(shareText, apiKey, debug) {
  const rawUrl = extractYoutubeUrl(shareText);
  if (!rawUrl) throw new Error('没找到有效的链接，请粘贴 YouTube 分享链接');
  if (!/youtu\.?be/i.test(rawUrl)) throw new Error('这不是 YouTube 链接，请检查后重试');

  const videoId = extractVideoId(rawUrl);
  const canonical = videoId ? 'https://www.youtube.com/watch?v=' + videoId : null;
  const routes = [];
  if (canonical) routes.push({ name: 'canonical', url: canonical });
  if (rawUrl !== canonical) routes.push({ name: 'raw', url: rawUrl });

  const dbg = debug ? { routes: [] } : null;
  let lastErr = null;
  for (const r of routes) {
    try {
      const data = await redfoxPost('/story/api/parseWork/videoDownload/youtube', apiKey, { url: r.url });
      const resources = extractResources(data || {});
      const title = data.desc || data.title || '';
      const cover = ensureHttps(data.cover || data.coverUrl || data.cover_url || '');
      if (dbg)
        dbg.routes.push({
          name: r.name,
          keys: data ? Object.keys(data) : [],
          resources: resources.length,
        });
      if (resources.length) {
        return {
          title: String(title).slice(0, 200),
          cover,
          videoId: videoId || '',
          resources,
          ...(debug ? { debug: dbg } : {}),
        };
      }
      lastErr = new Error('解析到了内容，但没找到可下载的地址（可能视频已删除或有地区限制）');
      if (dbg) dbg.routes[dbg.routes.length - 1].empty = true;
    } catch (e) {
      lastErr = e;
      if (dbg) dbg.routes.push({ name: r.name, error: String(e.message || e).slice(0, 120) });
    }
  }
  const err = new Error(lastErr ? lastErr.message : '解析失败，请稍后重试');
  if (debug) err.debug = dbg;
  throw err;
}

// ---------- 解析 ----------
async function handleParse(request, env) {
  const apiKey = (env.REDFOX_API_KEY || '').trim();
  if (!apiKey)
    return json(
      {
        ok: false,
        error:
          '未配置 RedFoxHub API Key：请去 redfox.hk 注册并在控制台「API密钥」创建一个 key（可与小红书/TikTok/抖音站复用同一个），然后在 Cloudflare Pages → Settings → Environment variables 添加 REDFOX_API_KEY（重新部署后生效）',
      },
      500
    );
  const reqUrl = new URL(request.url);
  const shareText = reqUrl.searchParams.get('url') || '';
  if (!shareText.trim()) return json({ ok: false, error: '请先粘贴 YouTube 分享链接' }, 400);
  const debug = reqUrl.searchParams.get('debug') === '1';

  // 解析接口人机验证（配了 TURNSTILE_SECRET_KEY 才生效）
  const tsSecret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (tsSecret) {
    const tsToken = reqUrl.searchParams.get('turnstile') || '';
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    const tsOk = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip'));
    if (!tsOk) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  // 解析冷却：同一 IP 60 秒内只能解析一次（防刷 API 烧积分）
  const PARSE_COOLDOWN_SECS = 60;
  const parseIp = request.headers.get('cf-connecting-ip') || '';
  if (parseIp && env.FEEDBACK_KV) {
    const lastTs = await env.FEEDBACK_KV.get('pcool_' + parseIp);
    if (lastTs) {
      const remain = PARSE_COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
      if (remain > 0) return json({ ok: false, error: `解析太频繁，请 ${remain} 秒后再试` }, 429);
    }
  }

  try {
    const result = await parseYoutubeViaRedFox(shareText, apiKey, debug);
    if (parseIp && env.FEEDBACK_KV)
      await env.FEEDBACK_KV.put('pcool_' + parseIp, String(Date.now()), {
        expirationTtl: PARSE_COOLDOWN_SECS,
      });
    // 本站解析次数统计（仅成功计数）
    if (env.FEEDBACK_KV) {
      try {
        const cur = Number((await env.FEEDBACK_KV.get('stats_parse_youtube')) || 0);
        await env.FEEDBACK_KV.put('stats_parse_youtube', String(cur + 1));
      } catch {}
    }
    return json({ ok: true, ...result });
  } catch (e) {
    const body = { ok: false, error: e.message || '解析失败' };
    if (debug && e.debug) body.debug = e.debug;
    return json(body, 502);
  }
}

/* ================= 反馈系统（KV 存储 + 管理后台，与小红书/TikTok/抖音站共用） ================= */
async function handleFeedbackSubmit(request, env) {
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '反馈功能暂未启用' }, 500);
  const ct = request.headers.get('content-type') || '';
  let message = '',
    contact = '',
    page = '',
    tsToken = '',
    files = [];
  if (ct.includes('multipart/form-data')) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    message = String(form.get('message') || '').trim();
    contact = String(form.get('contact') || '').trim().slice(0, 120);
    page = String(form.get('page') || '').slice(0, 200);
    tsToken = String(form.get('cf-turnstile-response') || '');
    files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size > 0);
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    message = String(body.message || '').trim();
    contact = String(body.contact || '').trim().slice(0, 120);
    page = String(body.page || '').slice(0, 200);
    tsToken = String(body['cf-turnstile-response'] || '');
  }
  if (!message) return json({ ok: false, error: '请填写反馈内容' }, 400);
  if (message.length > 2000) return json({ ok: false, error: '内容太长，请精简到 2000 字以内' }, 400);
  if (files.length > 3) return json({ ok: false, error: '最多上传 3 个附件' }, 400);

  const tsSecret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (tsSecret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    const tsOk = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip'));
    if (!tsOk) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  const COOLDOWN_SECS = 600;
  const clientIp = request.headers.get('cf-connecting-ip') || '';
  if (clientIp) {
    const lastTs = await env.FEEDBACK_KV.get('cool_' + clientIp);
    if (lastTs) {
      const remain = COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
      if (remain > 0)
        return json(
          { ok: false, error: `提交太频繁，请 ${Math.max(1, Math.ceil(remain / 60))} 分钟后再试` },
          429
        );
    }
  }

  const id = 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const attachments = [];
  if (files.length) {
    if (!env.FEEDBACK_BUCKET) return json({ ok: false, error: '附件功能暂未启用' }, 500);
    for (const f of files) {
      const type = f.type || '';
      if (!/^(image|video)\//.test(type))
        return json({ ok: false, error: '只支持图片和视频附件' }, 400);
      if (f.size > 20 * 1024 * 1024)
        return json({ ok: false, error: '单个附件不能超过 20MB' }, 400);
      const ext =
        (String(f.name || '').split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) ||
        'bin';
      const key = `fb/${id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await env.FEEDBACK_BUCKET.put(key, f.stream(), {
        httpMetadata: { contentType: type },
      });
      attachments.push({ key, type, name: String(f.name || '').slice(0, 80), size: f.size });
    }
  }

  const record = {
    id,
    message: message.slice(0, 2000),
    contact,
    page,
    attachments,
    ua: (request.headers.get('user-agent') || '').slice(0, 200),
    ip: request.headers.get('cf-connecting-ip') || '',
    time: new Date().toISOString(),
  };
  await env.FEEDBACK_KV.put(id, JSON.stringify(record));
  if (clientIp)
    await env.FEEDBACK_KV.put('cool_' + clientIp, String(Date.now()), {
      expirationTtl: COOLDOWN_SECS,
    });
  return json({ ok: true });
}

function checkAdminKey(url, env) {
  const key = env.FEEDBACK_ADMIN_KEY || '';
  return !!key && url.searchParams.get('key') === key;
}

async function handleFeedbackList(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const listed = await env.FEEDBACK_KV.list({ prefix: 'fb_' });
  const items = [];
  for (const k of listed.keys) {
    try {
      const v = await env.FEEDBACK_KV.get(k.name);
      if (v) items.push(JSON.parse(v));
    } catch {}
  }
  items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return json({ ok: true, count: items.length, items });
}

async function handleFeedbackDelete(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const id = url.searchParams.get('id') || '';
  if (!/^fb_[a-z0-9_]+$/i.test(id)) return json({ ok: false, error: '参数错误' }, 400);
  try {
    const v = await env.FEEDBACK_KV.get(id);
    if (v) {
      const rec = JSON.parse(v);
      if (env.FEEDBACK_BUCKET && Array.isArray(rec.attachments)) {
        for (const a of rec.attachments) {
          try {
            await env.FEEDBACK_BUCKET.delete(a.key);
          } catch {}
        }
      }
    }
  } catch {}
  await env.FEEDBACK_KV.delete(id);
  return json({ ok: true });
}

async function handleFeedbackFile(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return new Response('无权访问', { status: 403 });
  if (!env.FEEDBACK_BUCKET) return new Response('未绑定存储', { status: 500 });
  const m = url.pathname.match(/^\/api\/fb-file\/(.+)$/);
  const key = m ? decodeURIComponent(m[1]) : '';
  if (!key.startsWith('fb/') || key.includes('..')) return new Response('参数错误', { status: 400 });
  const obj = await env.FEEDBACK_BUCKET.get(key);
  if (!obj) return new Response('文件不存在', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>反馈管理</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f7f7f8;color:#222}
.wrap{max-width:640px;margin:0 auto;padding:16px 14px 60px}
h1{font-size:20px;margin:8px 0 4px}h1 span{font-size:13px;color:#888;font-weight:400}
.fb{background:#fff;border-radius:12px;padding:12px 14px;margin-top:12px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.fb .meta{font-size:12px;color:#999;margin-bottom:6px}
.fb .site{font-size:11px;color:#ff2442;font-weight:600}
.fb .msg{font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.fb button{margin-top:8px;background:#f0f0f2;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#c00}
.empty{text-align:center;color:#aaa;margin-top:40px;font-size:14px}
</style></head>
<body><div class="wrap">
<h1>用户反馈 <span id="count"></span></h1>
<div style="margin:6px 0 4px"><a href="/dashboard?key=" id="dashLink" style="font-size:13px;color:#FE2C55">📊 数据总览</a></div>
<script>document.getElementById('dashLink').href = '/dashboard?key=' + encodeURIComponent(new URLSearchParams(location.search).get('key') || '');</script>
<div id="list">加载中…</div>
</div><script>
const key = new URLSearchParams(location.search).get('key') || '';
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const siteName = (p) => {
  try {
    const h = new URL(p).hostname;
    if (h.includes('tiktok')) return 'TikTok站';
    if (h.includes('xiaohongshu')) return '小红书站';
    if (h.includes('douyin')) return '抖音站';
    if (h.includes('youtube')) return 'YouTube站';
    return h;
  } catch { return ''; }
};
async function load() {
  const box = document.getElementById('list');
  try {
    const r = await fetch('/api/feedback/list?key=' + encodeURIComponent(key));
    const j = await r.json();
    if (!j.ok) { box.innerHTML = '<div class="empty">加载失败：' + esc(j.error) + '</div>'; return; }
    document.getElementById('count').textContent = '共 ' + j.count + ' 条';
    if (!j.items.length) { box.innerHTML = '<div class="empty">暂无反馈</div>'; return; }
    box.innerHTML = '';
    for (const it of j.items) {
      const d = document.createElement('div');
      d.className = 'fb';
      const t = new Date(it.time).toLocaleString('zh-CN', { hour12: false });
      d.innerHTML = '<div class="meta"><span class="site">[' + esc(siteName(it.page)) + ']</span> ' + esc(t) + (it.contact ? ' · ' + esc(it.contact) : '') + '</div>' +
        '<div class="msg">' + esc(it.message) + '</div>';
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 复制文本';
      copyBtn.style.cssText = 'margin-top:8px;background:#f0f0f2;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;cursor:pointer';
      copyBtn.onclick = function(){
        const txt = it.message || '';
        const done = function(){ copyBtn.textContent = '✅ 已复制'; setTimeout(function(){ copyBtn.textContent = '📋 复制文本'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(function(){ alert('复制失败'); });
        } else { alert('当前浏览器不支持一键复制'); }
      };
      d.appendChild(copyBtn);
      if (it.attachments && it.attachments.length) {
        const att = document.createElement('div');
        for (const a of it.attachments) {
          const src = '/api/fb-file/' + encodeURIComponent(a.key) + '?key=' + encodeURIComponent(key);
          const fname = esc(String(a.name || 'attachment'));
          if (String(a.type || '').startsWith('image/')) {
            att.innerHTML += '<img src="' + src + '" style="max-width:100%;border-radius:8px;margin-top:8px;display:block" loading="lazy">';
          } else {
            att.innerHTML += '<video src="' + src + '" controls playsinline style="max-width:100%;border-radius:8px;margin-top:8px;display:block"></video>';
          }
          att.innerHTML += '<a href="' + src + '" download="' + fname + '" style="display:inline-block;margin-top:6px;background:#f0f0f2;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;text-decoration:none">⬇ 下载</a>';
        }
        d.appendChild(att);
      }
      const btn = document.createElement('button');
      btn.textContent = '删除';
      btn.onclick = async () => {
        if (!confirm('删除这条反馈？')) return;
        await fetch('/api/feedback?id=' + encodeURIComponent(it.id) + '&key=' + encodeURIComponent(key), { method: 'DELETE' });
        load();
      };
      d.appendChild(btn);
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = '<div class="empty">网络错误</div>'; }
}
load();
<\/script></body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>数据总览</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#0f0f13;color:#f1f1f3}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:10px 0 4px}h1 span{font-size:13px;color:#9a9aa3;font-weight:400}
.sub{font-size:13px;color:#9a9aa3;margin-bottom:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:#1a1a21;border-radius:16px;padding:20px 16px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.35)}
.card .name{font-size:14px;color:#9a9aa3;margin-bottom:8px}
.card .num{font-size:36px;font-weight:800;color:#FE2C55}
.card .unit{font-size:12px;color:#9a9aa3;margin-top:4px}
.total{margin-top:12px;background:linear-gradient(135deg,#FE2C55,#ff6b4a);border-radius:16px;padding:18px;text-align:center}
.total .num{font-size:32px;font-weight:800}
.total .label{font-size:13px;opacity:.85;margin-top:4px}
.refresh{margin-top:16px;text-align:center}
.refresh button{background:#2a2a34;border:none;border-radius:12px;padding:12px 32px;font-size:14px;color:#f1f1f3;cursor:pointer}
.err{text-align:center;color:#ff8ba0;margin-top:20px;font-size:14px}
.links{margin-top:16px;text-align:center;font-size:13px}
.links a{color:#9a9aa3;margin:0 8px}
</style></head>
<body><div class="wrap">
<h1>📊 数据总览 <span id="time"></span></h1>
<div class="sub">四站解析次数统计（仅成功计数）</div>
<div class="grid" id="grid"><div class="err">加载中…</div></div>
<div class="total" id="total" style="display:none"><div class="num" id="totalNum">0</div><div class="label">累计解析</div></div>
<div class="refresh"><button onclick="load()">🔄 刷新</button></div>
<div class="links"><a href="/admin?key=" id="adminLink">💬 反馈管理</a></div>
</div><script>
const key = new URLSearchParams(location.search).get('key') || '';
document.getElementById('adminLink').href = '/admin?key=' + encodeURIComponent(key);
async function load(){
  const grid = document.getElementById('grid');
  try{
    const r = await fetch('/api/stats-all?key=' + encodeURIComponent(key));
    const j = await r.json();
    if(!j.ok){ grid.innerHTML = '<div class="err">加载失败：' + (j.error || '未知错误') + '</div>'; return; }
    grid.innerHTML = '';
    let sum = 0;
    for(const s of j.sites){
      sum += s.count;
      const d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<div class="name">' + s.name + '</div><div class="num">' + s.count + '</div><div class="unit">次解析</div>';
      grid.appendChild(d);
    }
    document.getElementById('totalNum').textContent = sum;
    document.getElementById('total').style.display = 'block';
    document.getElementById('time').textContent = new Date().toLocaleString('zh-CN', {hour12:false});
  }catch(e){ grid.innerHTML = '<div class="err">网络错误</div>'; }
}
load();
<\/script></body></html>`;

/* ================= 数据总览 ================= */
async function handleStatsAll(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  const sites = [
    { key: 'stats_parse_tiktok', name: 'TikTok站' },
    { key: 'stats_parse_xhs', name: '小红书站' },
    { key: 'stats_parse_douyin', name: '抖音站' },
    { key: 'stats_parse_youtube', name: 'YouTube站' },
  ];
  const result = [];
  for (const s of sites) {
    let n = 0;
    if (env.FEEDBACK_KV) {
      try { n = Number((await env.FEEDBACK_KV.get(s.key)) || 0); } catch {}
    }
    result.push({ name: s.name, count: n });
  }
  return json({ ok: true, sites: result });
}

/* ================= 路由 ================= */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/parse') return handleParse(request, env);

    if (url.pathname === '/api/diag')
      return json({
        ok: true,
        hasApiKey: !!(env.REDFOX_API_KEY || '').trim(),
        hasAssets: typeof env.ASSETS?.fetch === 'function',
      });

    // Turnstile 公开 site key 下发
    if (url.pathname === '/api/turnstile-key')
      return json({ ok: true, siteKey: (env.TURNSTILE_SITE_KEY || '').trim() });

    // 本站解析次数
    if (url.pathname === '/api/stats') {
      let n = 0;
      if (env.FEEDBACK_KV) {
        try {
          n = Number((await env.FEEDBACK_KV.get('stats_parse_youtube')) || 0);
        } catch {}
      }
      return json({ ok: true, parseCount: n });
    }

    if (url.pathname === '/api/feedback') {
      if (request.method === 'POST') return handleFeedbackSubmit(request, env);
      if (request.method === 'DELETE') return handleFeedbackDelete(request, env);
      return json({ ok: false, error: '方法不支持' }, 405);
    }
    if (url.pathname === '/api/feedback/list') return handleFeedbackList(request, env);
    if (url.pathname.startsWith('/api/fb-file/')) return handleFeedbackFile(request, env);
    if (url.pathname === '/api/stats-all') return handleStatsAll(request, env);
    if (url.pathname === '/dashboard') {
      if (!checkAdminKey(url, env))
        return new Response('无权访问：在地址后加上 ?key=你的管理密码，例如 /dashboard?key=xxx', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname === '/admin') {
      if (!checkAdminKey(url, env))
        return new Response('无权访问：在地址后加上 ?key=你的管理密码，例如 /admin?key=xxx', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      try {
        return await env.ASSETS.fetch(request);
      } catch {}
    }
    return new Response('Not Found', { status: 404 });
  },
};
