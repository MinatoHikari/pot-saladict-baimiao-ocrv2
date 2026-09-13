// 白描 OCR 识别插件（修复版）for Saladict (pot-desktop fork)
//
// 2026 年白描网页版接口升级为 v2：
//   旧流程：图片以 dataUrl 直接提交 /api/ocr/image/{engine} —— 现已被服务端拒绝（"图片上传出错"）
//   新流程：GET /oss/sign 获取阿里云 OSS 签名 -> multipart 上传图片拿到 file_key
//           -> 提交识别时携带 fileKey（不再携带 dataUrl）
//
// 设备与登录状态通过 SQLite 持久化（uuid 稳定，避免每次识别都触发"新设备登录"）；
// Database 不可用时自动降级为内存模式（每次重新登录）。
//
// main.js 为普通脚本（应用以 eval 方式加载），必须定义与 plugin_type 同名的 recognize 函数。
// 配置项由 info.json 的 needs 声明：username / password（均可选，不填走匿名模式）

var BAIMIAO_API = 'https://web.baimiaoapp.com/api';
var PLUGIN_DB_PATH = 'sqlite:plugins/recognize/plugin.com.saladict.baimiao-ocr/state.db';
var UPLOAD_MIME = 'image/png';
var POLL_INTERVAL_MS = 500;
var POLL_MAX = 120; // 最长等待约 60 秒

// pot 语言代码 -> 语言名（白描接口按图自动识别语言，此表仅作占位映射）
var LANGUAGE = {
    auto: 'Auto',
    zh_cn: 'Simplified Chinese',
    zh_tw: 'Traditional Chinese',
    yue: 'Cantonese',
    ja: 'Japanese',
    en: 'English',
    ko: 'Korean',
    fr: 'French',
    es: 'Spanish',
    ru: 'Russian',
    de: 'German',
    it: 'Italian',
    tr: 'Turkish',
    pt_pt: 'Portuguese',
    pt_br: 'Brazilian Portuguese',
    vi: 'Vietnamese',
    id: 'Indonesian',
    th: 'Thai',
    ms: 'Malay',
    ar: 'Arabic',
    hi: 'Hindi',
    mn_mo: 'Mongolian',
    mn_cy: 'Mongolian (Cyrillic)',
    km: 'Khmer',
    nb_no: 'Norwegian Bokmål',
    nn_no: 'Norwegian Nynorsk',
    fa: 'Persian',
    sv: 'Swedish',
    pl: 'Polish',
    nl: 'Dutch',
    uk: 'Ukrainian',
    he: 'Hebrew'
};

// 纯 JS SHA1（utils.CryptoJS 缺失时的兜底），输出十六进制
function sha1Hex(str) {
    function rol(n, b) { return (n << b) | (n >>> (32 - b)); }
    function toUtf8(s) {
        try {
            return unescape(encodeURIComponent(s));
        } catch (e) {
            return s;
        }
    }
    var msg = toUtf8(str);
    var ml = msg.length;
    var words = [];
    for (var i = 0; i < ml; i++) {
        words[i >> 2] = (words[i >> 2] || 0) | (msg.charCodeAt(i) << (24 - (i % 4) * 8));
    }
    words[ml >> 2] = (words[ml >> 2] || 0) | (0x80 << (24 - (ml % 4) * 8));
    words[(((ml + 8) >> 6) + 1) * 16 - 1] = ml * 8;
    var H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    for (var k = 0; k < words.length; k += 16) {
        var w = [];
        for (var j = 0; j < 16; j++) w[j] = words[k + j] || 0;
        for (var j2 = 16; j2 < 80; j2++) {
            w[j2] = rol(w[j2 - 3] ^ w[j2 - 8] ^ w[j2 - 14] ^ w[j2 - 16], 1);
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
        for (var j3 = 0; j3 < 80; j3++) {
            var f, t;
            if (j3 < 20) { f = (b & c) | (~b & d); t = 0x5a827999; }
            else if (j3 < 40) { f = b ^ c ^ d; t = 0x6ed9eba1; }
            else if (j3 < 60) { f = (b & c) | (b & d) | (c & d); t = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; t = 0xca62c1d6; }
            var tmp = (rol(a, 5) + f + e + t + w[j3]) | 0;
            e = d; d = c; c = rol(b, 30); b = a; a = tmp;
        }
        H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0];
    }
    var out = '';
    for (var h = 0; h < 5; h++) {
        out += ('00000000' + ((H[h] >>> 0).toString(16))).slice(-8);
    }
    return out;
}

function computeSha1(utils, text) {
    var C = utils.CryptoJS;
    if (C && C.SHA1 && C.enc && C.enc.Hex) {
        return C.SHA1(text).toString(C.enc.Hex);
    }
    return sha1Hex(text);
}

function newUuid() {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* 忽略 */ }
    var s = '';
    for (var i = 0; i < 32; i++) {
        s += Math.floor(Math.random() * 16).toString(16);
    }
    return s;
}

function base64ToBytes(b64) {
    if (typeof atob === 'function') {
        var raw = atob(b64);
        var arr = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
    }
    var BIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    var bytes = [];
    for (var j = 0; j < clean.length; j += 4) {
        var n = (BIN.indexOf(clean[j]) << 18) | (BIN.indexOf(clean[j + 1]) << 12) |
                ((BIN.indexOf(clean[j + 2]) & 63) << 6) | (BIN.indexOf(clean[j + 3]) & 63);
        bytes.push((n >> 16) & 0xff);
        if (clean[j + 2] !== '=') bytes.push((n >> 8) & 0xff);
        if (clean[j + 3] !== '=') bytes.push(n & 0xff);
    }
    return bytes;
}

function utf8Bytes(s) {
    var enc = encodeURIComponent(s);
    var out = [];
    for (var i = 0; i < enc.length; i++) {
        if (enc[i] === '%') {
            out.push(parseInt(enc.substr(i + 1, 2), 16));
            i += 2;
        } else {
            out.push(enc.charCodeAt(i));
        }
    }
    return out;
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 统一请求层：优先 utils.http.fetch（tauri http），其次 utils.tauriFetch，最后全局 fetch
function createRequester(utils) {
    var http = utils.http;
    var useTauri = (http && typeof http.fetch === 'function') || typeof utils.tauriFetch === 'function';
    var tauriFetch = useTauri ? (utils.tauriFetch || http.fetch) : null;

    return async function request(url, opts) {
        opts = opts || {};
        var headers = opts.headers || {};
        if (useTauri) {
            var body;
            if (opts.json !== undefined) {
                body = { type: 'Json', payload: opts.json };
            } else if (opts.bytes) {
                // 原始字节体（用于手工构造的 multipart），绕开 formBody/multipart 封装
                body = { type: 'Bytes', payload: opts.bytes };
            }
            var init = { method: opts.method || 'GET', headers: headers, body: body };
            if (opts.responseTypeText) init.responseType = 2; // ResponseType.Text
            var res = await tauriFetch(url, init);
            if (!res) throw 'Http Request Error: 无响应';
            return res;
        }
        if (typeof fetch !== 'function') {
            throw '插件运行环境缺少网络接口（http / tauriFetch / fetch）';
        }
        var init2 = { method: opts.method || 'GET', headers: headers };
        if (opts.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            init2.body = JSON.stringify(opts.json);
        } else if (opts.bytes) {
            init2.body = new Blob([new Uint8Array(opts.bytes)], { type: headers['Content-Type'] });
        }
        var res2 = await fetch(url, init2);
        var data = null;
        var text = '';
        try {
            text = await res2.text();
            data = JSON.parse(text);
        } catch (e) {
            data = text;
        }
        return { ok: res2.ok, status: res2.status, data: data };
    };
}

function throwApiError(res) {
    var msg = res && res.data && res.data.msg ? res.data.msg : '';
    throw 'Http Request Error\nHttp Status: ' + (res && res.status ? res.status : '未知') +
        (msg ? '\n' + msg : '\n' + String(JSON.stringify(res && res.data)).slice(0, 400));
}

// 设备/登录状态持久化：uuid 稳定避免"新设备"，token 复用避免重复登录
function createStateStore(utils) {
    var mem = {};
    var Database = utils.Database;
    var db = null;
    return {
        load: async function () {
            if (!Database) return mem;
            try {
                db = await Database.load(PLUGIN_DB_PATH);
                await db.execute('CREATE TABLE IF NOT EXISTS device (k TEXT PRIMARY KEY, v TEXT)');
                var kv = await db.select('SELECT k, v FROM device');
                for (var i = 0; i < kv.length; i++) mem[kv[i].k] = kv[i].v;
            } catch (e) {
                db = null; // 数据库不可用，退化为内存模式
            }
            return mem;
        },
        save: async function (key, value) {
            mem[key] = value;
            if (!db) return;
            try {
                await db.execute('DELETE FROM device WHERE k = $1', [key]);
                await db.execute('INSERT INTO device (k, v) VALUES ($1, $2)', [key, value]);
            } catch (e) { /* 忽略写失败 */ }
        }
    };
}

async function recognize(base64, _lang, options) {
    options = options || {};
    var config = options.config || {};
    var utils = options.utils || {};
    if (!base64) throw '未收到图片数据';

    var request = createRequester(utils);
    var store = createStateStore(utils);
    var state = await store.load();
    var uuid = state.uuid || newUuid();
    var username = (config.username || '').trim();
    var password = (config.password || '').trim();

    var authHeaders = {
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://web.baimiaoapp.com',
        'Referer': 'https://web.baimiaoapp.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'X-Auth-Uuid': uuid,
        'X-Auth-Token': ''
    };
    function authed(token) {
        var h = {};
        for (var k in authHeaders) h[k] = authHeaders[k];
        h['X-Auth-Token'] = token;
        return h;
    }

    // 登录（账号或匿名），uuid 保持稳定 -> 服务端视为同一设备
    async function login() {
        var token = '';
        if (username && password) {
            var loginRes = await request(BAIMIAO_API + '/user/login', {
                method: 'POST',
                headers: authHeaders,
                json: {
                    username: username,
                    password: password,
                    type: /^[0-9]*$/.test(username) ? 'mobile' : 'email'
                }
            });
            if (!loginRes.ok) throwApiError(loginRes);
            var loginData = loginRes.data || {};
            if (loginData.code !== 1 || !loginData.data || !loginData.data.token) {
                throw '白描登录失败：' + (loginData.msg || JSON.stringify(loginData).slice(0, 200));
            }
            token = loginData.data.token;
        } else {
            var anonRes = await request(BAIMIAO_API + '/user/login/anonymous', {
                method: 'POST',
                headers: authHeaders,
                json: {}
            });
            if (!anonRes.ok) throwApiError(anonRes);
            var anonData = anonRes.data || {};
            if (anonData.code !== 1 || !anonData.data) {
                throw '白描匿名登录失败：' + (anonData.msg || JSON.stringify(anonData).slice(0, 200));
            }
            token = anonData.data.token || '';
            if (!token) {
                throw '当前匿名额度已用完，请在插件配置中填写白描账号（手机号/邮箱 + 密码）';
            }
        }
        await store.save('uuid', uuid);
        await store.save('token', token);
        return token;
    }

    var token = state.token || '';

    // 2. 申请识别额度（v2 接口）；token 为空/失效（含 HTTP 401/403）时自动重登一次
    async function getPerm() {
        var permRes = await request(BAIMIAO_API + '/perm/single', {
            method: 'POST',
            headers: authed(token),
            json: { mode: 'single', version: 'v2' }
        });
        if (!permRes.ok && permRes.status !== 401 && permRes.status !== 403) throwApiError(permRes);
        return permRes.data || {};
    }
    var perm = await getPerm().catch(function (e) { return { __err: String(e) }; });
    if (perm.__err || perm.code !== 1 || !perm.data || !perm.data.token || !perm.data.engine) {
        token = await login();
        authHeaders['X-Auth-Token'] = token;
        perm = await getPerm();
    }
    if (perm.__err) throw perm.__err;
    if (perm.code !== 1 || !perm.data || !perm.data.token || !perm.data.engine) {
        throw '白描额度获取失败（可能已达今日上限）：' + (perm.msg || JSON.stringify(perm).slice(0, 200));
    }
    var permToken = perm.data.token;
    var engine = perm.data.engine;

    // 3. 获取 OSS 上传签名
    var signRes = await request(BAIMIAO_API + '/oss/sign?mime_type=' + UPLOAD_MIME, {
        method: 'GET',
        headers: authed(token)
    });
    if (!signRes.ok) throwApiError(signRes);
    var signData = signRes.data || {};
    if (signData.code !== 1 || !signData.data || !signData.data.result) {
        throw '获取白描上传签名失败：' + (signData.msg || JSON.stringify(signData).slice(0, 200));
    }
    var oss = signData.data.result;

    // 4. 上传图片：手工构造 multipart 字节流，以 Bytes 原始字节体发送
    //    （不依赖 tauri 的 formBody/multipart 封装，与实测成功的请求字节一致）
    var bytes = base64ToBytes(base64);
    var dataUrl = 'data:' + UPLOAD_MIME + ';base64,' + base64;
    var imgHash = computeSha1(utils, dataUrl);
    var boundary = '----SaladictBoundary' + newUuid().replace(/-/g, '');
    var CRLF = '\r\n';
    var headFields = [
        ['success_action_status', '200'],
        ['policy', oss.policy],
        ['x-oss-signature', oss.signature],
        ['x-oss-signature-version', 'OSS4-HMAC-SHA256'],
        ['x-oss-credential', oss.x_oss_credential],
        ['x-oss-date', oss.x_oss_date],
        ['key', oss.file_key],
        ['x-oss-security-token', oss.security_token]
    ];
    var bodyBytes = [];
    for (var f = 0; f < headFields.length; f++) {
        bodyBytes = bodyBytes.concat(utf8Bytes(
            '--' + boundary + CRLF +
            'Content-Disposition: form-data; name="' + headFields[f][0] + '"' + CRLF + CRLF +
            headFields[f][1] + CRLF
        ));
    }
    bodyBytes = bodyBytes.concat(utf8Bytes(
        '--' + boundary + CRLF +
        'Content-Disposition: form-data; name="file"; filename="blob"' + CRLF +
        'Content-Type: ' + UPLOAD_MIME + CRLF + CRLF
    ));
    bodyBytes = bodyBytes.concat(Array.isArray(bytes) ? bytes : Array.from(bytes));
    bodyBytes = bodyBytes.concat(utf8Bytes(CRLF + '--' + boundary + '--' + CRLF));

    var uploadRes = await request(oss.host, {
        method: 'POST',
        responseTypeText: true,
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        bytes: bodyBytes
    });
    if (!uploadRes.ok || uploadRes.status !== 200) {
        throw '图片上传失败（OSS Http ' + (uploadRes.status || '未知') + '）：' +
            String(uploadRes.data || '').slice(0, 300);
    }

    // 5. 提交识别（v2：携带 fileKey，不再携带 dataUrl）
    var submitRes = await request(BAIMIAO_API + '/ocr/image/' + engine, {
        method: 'POST',
        headers: authed(token),
        json: {
            batchId: '',
            total: 1,
            token: permToken,
            hash: imgHash,
            fileKey: oss.file_key
        }
    });
    if (!submitRes.ok) throwApiError(submitRes);
    var submitData = submitRes.data || {};
    if (submitData.code !== 1 || !submitData.data || !submitData.data.jobStatusId) {
        throw '白描识别提交失败：' + (submitData.msg || JSON.stringify(submitData).slice(0, 200));
    }
    var jobStatusId = submitData.data.jobStatusId;

    // 6. 轮询识别结果
    var statusUrl = BAIMIAO_API + '/ocr/image/' + engine + '/status?jobStatusId=' + encodeURIComponent(jobStatusId);
    for (var i = 0; i < POLL_MAX; i++) {
        await sleep(POLL_INTERVAL_MS);
        var statusRes = await request(statusUrl, { method: 'GET', headers: authed(token) });
        if (!statusRes.ok) throwApiError(statusRes);
        var sData = statusRes.data || {};
        if (sData.code !== 1 || !sData.data) {
            throw '白描识别状态查询失败：' + (sData.msg || JSON.stringify(sData).slice(0, 200));
        }
        if (!sData.data.isEnded) continue;
        var yd = sData.data.ydResp;
        var rows = yd && (yd.words_result || (yd.Result && yd.Result.words_result));
        if (!rows) {
            throw '白描识别失败：' + String(JSON.stringify(yd || sData.data)).slice(0, 300);
        }
        var text = '';
        for (var r = 0; r < rows.length; r++) {
            text += rows[r].words;
            if (r < rows.length - 1) text += '\n';
        }
        return text;
    }
    throw '白描识别超时，请稍后重试';
}
