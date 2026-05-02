const https = require('https');
const http = require('http');
const crypto = require('crypto');
const url = require('url');

// Your registered Azure AD application
const CLIENT_ID = 'e1e9aa8a-ea95-45d1-884e-61cf6ea683ac';
const REDIRECT_PORT = 38123;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const SCOPE = 'XboxLive.signin offline_access';

function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const proto = u.protocol === 'https:' ? https : http;
    const opt = {
      hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...opts.headers }
    };
    const req = proto.request(opt, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function base64URL(b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest(); }

// --- Wait for localhost callback ---
function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = url.parse(req.url, true);
      if (u.query.code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding-top:60px;background:#f5f5f7"><h2 style="color:#1d1d1f">授权成功</h2><p style="color:#6e6e73">可关闭此页面，返回启动器</p></body></html>');
        server.close();
        resolve(u.query.code);
      } else if (u.query.error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding-top:60px"><h2>授权取消</h2><p>请重试</p></body></html>');
        server.close();
        reject(new Error(u.query.error_description || '授权被取消'));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><script>location.search="?code="+location.hash.match(/code=([^&]+)/)[1]</script></body></html>');
        // handle implicit fragment
        const m = u.hash && u.hash.match(/code=([^&]+)/);
        if (m) {
          server.close();
          resolve(m[1]);
        }
      }
    });
    server.on('error', e => { server.close(); reject(e); });
    server.listen(REDIRECT_PORT);
    setTimeout(() => { server.close(); reject(new Error('登录超时（5分钟）')); }, 300000);
  });
}

// --- Exchange code for token ---
async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier
  }).toString();
  const res = await request('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (res.error) throw new Error(res.error_description || res.error);
  return res.access_token;
}

// --- Xbox → XSTS → Minecraft → Profile ---
async function xboxAuthChain(accessToken) {
  const xbl = await request('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST', body: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
    }
  });
  if (!xbl.Token) throw new Error('Xbox Live 认证失败: ' + JSON.stringify(xbl).slice(0, 300));

  const uhs = xbl.DisplayClaims.xui[0].uhs;

  const xsts = await request('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST', body: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
    }
  });
  if (xsts.error || !xsts.Token) {
    throw new Error(xsts.XErr === 2148916233 ? '此微软账号没有购买 Minecraft' : 'XSTS 失败: ' + JSON.stringify(xsts).slice(0, 300));
  }

  const mc = await request('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST', body: { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }
  });
  if (!mc.access_token) {
    throw new Error('Minecraft 认证失败: ' + JSON.stringify(mc).slice(0, 300));
  }

  const profile = await request('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` }
  });
  if (!profile.id) throw new Error('获取 Minecraft 档案失败: ' + JSON.stringify(profile).slice(0, 300));

  return { type: 'microsoft', name: profile.name, uuid: profile.id, accessToken: mc.access_token };
}

// --- Main entry ---
async function loginMicrosoft() {
  const { shell } = require('electron');

  // PKCE
  const codeVerifier = base64URL(crypto.randomBytes(32));
  const codeChallenge = base64URL(sha256(codeVerifier));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  const authUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?${params}`;

  // Open browser and start server concurrently
  shell.openExternal(authUrl);
  const code = await startCallbackServer();
  const token = await exchangeCode(code, codeVerifier);
  return await xboxAuthChain(token);
}

function loginOffline(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const uuid = [...hash].map((b, i) => {
    const hex = b.toString(16).padStart(2, '0');
    return (i === 4 || i === 6 || i === 8 || i === 10) ? '-' + hex : hex;
  }).join('');
  return { type: 'offline', name, uuid };
}

module.exports = { loginMicrosoft, loginOffline };
