import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { AIRequest, NetworkRequest } from '../types';

export type JsonRequester = (request: NetworkRequest, signal?: AbortSignal) => Promise<unknown>;

export const serviceRequest: JsonRequester = async (request, signal) => {
  signal?.throwIfAborted();
  const base = request.service === 'lyrics' ? 'https://lrclib.net/api/search' : 'https://api.mymemory.translated.net/get';
  const url = new URL(base);
  Object.entries(request.params).forEach(([key, value]) => url.searchParams.set(key, value));
  let operation: Promise<unknown>;
  if (window.tingyuDesktop) operation = window.tingyuDesktop.request(request);
  else if (Capacitor.isNativePlatform()) {
    operation = CapacitorHttp.get({ url: url.href, connectTimeout: 12000, readTimeout: 18000, responseType: 'json' }).then((response) => {
      if (response.status < 200 || response.status >= 300) throw new Error(`服务暂不可用（HTTP ${response.status}）`);
      return response.data;
    });
  } else {
    operation = fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000), credentials: 'omit', referrerPolicy: 'no-referrer' }).then(async (response) => {
      if (!response.ok) throw new Error(`服务暂不可用（HTTP ${response.status}）`);
      return response.json();
    });
  }
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('已取消联网操作', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
};

export function normalizeAIUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('请使用不含密码或参数的 HTTPS 接口地址。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

export async function requestAI(request: AIRequest, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  let operation: Promise<unknown>;
  if (window.tingyuDesktop) operation = window.tingyuDesktop.requestAI(request);
  else if (Capacitor.isNativePlatform()) {
    operation = CapacitorHttp.post({ url: request.url, headers: { Authorization: `Bearer ${request.key}`, 'Content-Type': 'application/json' }, data: request.body, connectTimeout: 12000, readTimeout: 90000, responseType: 'json', disableRedirects: true }).then((response) => {
      if (response.status < 200 || response.status >= 300) throw new Error(response.status === 401 ? 'API Key 无效，请检查翻译配置。' : `AI 服务请求失败（HTTP ${response.status}），请检查余额、模型与服务地址。`);
      return response.data;
    });
  } else {
    operation = fetch(request.url, { method: 'POST', headers: { Authorization: `Bearer ${request.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 401 ? 'API Key 无效，请检查翻译配置。' : `AI 服务请求失败（HTTP ${response.status}），请检查余额、模型与服务地址。`);
      return response.json();
    });
  }
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('已取消翻译', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
