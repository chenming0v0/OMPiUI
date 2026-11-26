'use strict';

const cap = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const open = document.getElementById('open');
const close = document.getElementById('close');
const statusText = document.getElementById('status');
const target = open.dataset.origin;
const expiresAt = Number(open.dataset.expiresAt);
let popup;
let state = 'waiting';
const request = (path, keepalive = false) => fetch(path, {
    method: 'POST', mode: 'same-origin', credentials: 'omit', cache: 'no-store',
    referrerPolicy: 'same-origin', keepalive, headers: { 'X-OMPiUI-Handoff': cap },
});

function finish(message) {
    state = 'closed';
    open.disabled = true;
    close.disabled = true;
    clearInterval(watch);
    statusText.textContent = message;
}

function end(message) {
    if (state === 'closed') return;
    finish(message);
    void request('/closed', true).catch(() => {});
}

function check() {
    if (popup?.closed) {
        end('远程工作台已关闭。');
    } else if (state === 'waiting' && Date.now() >= expiresAt) {
        popup?.close();
        end('授权已过期，请返回 OMPiUI 重新连接。');
    }
}

const watch = setInterval(check, 1000);
document.addEventListener('visibilitychange', check);
window.addEventListener('pagehide', () => end('远程连接已结束。'), { once: true });
window.addEventListener('message', async event => {
    if (state !== 'waiting' || !popup || event.source !== popup || event.origin !== target || event.data !== 'dsh.web.ready') return;
    if (Date.now() >= expiresAt) { check(); return; }
    state = 'sending';
    open.disabled = true;
    try {
        const response = await request('/grant');
        if (!response.ok) throw new Error();
        const browserGrant = await response.text();
        if (state !== 'sending') return;
        if (popup.closed || Date.now() >= expiresAt) throw new Error();
        // The portal's page issues the same-origin top-level POST /__remote/session.
        popup.postMessage({ type: 'dsh.web.grant', browserGrant }, target);
        state = 'handed-off';
        statusText.textContent = '已交接一次性授权。请保留此标签页；关闭本页将结束远程连接。';
    } catch {
        popup?.close();
        end('无法交接授权，请返回 OMPiUI 重新连接。');
    }
});
open.addEventListener('click', () => {
    if (state !== 'waiting') return;
    if (Date.now() >= expiresAt || popup?.closed) { check(); return; }
    if (popup) { popup.focus(); return; }
    popup = window.open(`${target}/__remote/browser`, '_blank');
    statusText.textContent = popup ? '正在等待远程工作台接收授权…' : '请允许打开新标签页后重试。';
});
close.addEventListener('click', () => {
    popup?.close();
    end('远程连接已结束。');
});
if (!/^[0-9a-f]{48}$/.test(cap)) finish('此授权页已失效，请返回 OMPiUI 重新连接。');
else check();
